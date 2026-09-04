/**
 * BFF proxy — forwards `/api/v1/*` from the browser to the FastAPI backend.
 *
 * Why a proxy: access tokens live in **HttpOnly** cookies. The browser
 * can't read them, so a direct browser→backend call can't add the
 * `Authorization: Bearer …` header. We route through this Next.js
 * handler instead — it reads the cookie server-side, attaches the
 * header, and forwards the response unchanged. The token never crosses
 * the wire to the browser.
 *
 * Retries once on 401:
 *   1. Initial request with the current access token.
 *   2. If backend returns 401, attempt a silent refresh via
 *      ``readSession`` (which uses the refresh cookie).
 *   3. On success, replay the original request with the new token and
 *      persist the refreshed access cookie on the outgoing response.
 *   4. On failure, return 401 + cleared cookies so the AuthGuard
 *      bounces the user to /login.
 *
 * Methods supported: GET, POST, PATCH, PUT, DELETE. The HEAD/OPTIONS
 * pre-flights are handled by Next.js itself; we don't need to forward
 * them since the backend's CORS rules don't apply on a same-origin
 * request.
 */

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import { serverEnv } from '@/env';
import { AUTH_COOKIES, clearAuthCookies, setAuthCookies } from '@/lib/auth/cookies';
import { CSRF_BLOCKED, isCrossSiteMutation } from '@/lib/auth/csrf';
import { backend, BackendError } from '@/lib/auth/backend';
import type { BackendTokens } from '@/lib/auth/types';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Build the upstream path from the catch-all segments.
 *
 * `encodeURIComponent` does NOT encode dots, so a `..` segment used to
 * survive into the URL string handed to `fetch`, which then normalised it
 * away — letting a caller climb out of the `/v1` prefix and address other
 * endpoints on the fixed backend host. Reject the traversal segments
 * outright instead of relying on the encoder to neutralise them.
 *
 * Returns null when the path is not acceptable; the caller turns that into
 * a 400 rather than forwarding anything upstream.
 */
function joinPath(parts: string[]): string | null {
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (p === '.' || p === '..') return null;
    // Encoded traversal ("%2e%2e") and injected separators. Decoding first
    // catches the encoded forms; the raw check catches literal separators.
    let decoded = p;
    try {
      decoded = decodeURIComponent(p);
    } catch {
      return null; // malformed percent-encoding
    }
    if (decoded === '.' || decoded === '..') return null;
    if (/[/\\]/.test(decoded) || decoded.includes('\0')) return null;
  }
  return `/${parts.map((p) => encodeURIComponent(p)).join('/')}`;
}


/** Headers forwarded *to* the backend. Stripped of hop-by-hop + Next.js noise. */
function forwardableHeaders(req: NextRequest, accessToken: string): Headers {
  const h = new Headers();
  const ct = req.headers.get('content-type');
  if (ct) h.set('content-type', ct);
  const accept = req.headers.get('accept');
  if (accept) h.set('accept', accept);
  // X-Request-Id passthrough so the backend's request_context can correlate.
  const rid = req.headers.get('x-request-id');
  if (rid) h.set('x-request-id', rid);

  // ── Forward the *real client* identity so audit rows (reauth events,
  //    future entity history) record who actually did the action.
  //    Without these, every audit row would attribute to the Node BFF.
  const ua = req.headers.get('user-agent');
  if (ua) h.set('user-agent', ua);

  // ``X-Forwarded-For`` — feeds the client IP on Part 11 audit rows.
  //
  // This proxy deliberately makes NO trust decision. It passes the chain
  // along and appends its own view of the peer; the backend decides which
  // entry is trustworthy using ``TRUSTED_PROXY_COUNT`` (see
  // ``_client_ip`` in api/v1/routes/auth.py). One component owning that
  // decision is the point — the old code picked the LEFTMOST entry, which
  // is whatever the caller sent, so a browser could choose the IP written
  // against its own signature.
  //
  // Why not just forward `req.ip`: Next.js only populates it on platforms
  // that inject it (Vercel). Self-hosted behind CloudFront + Elastic
  // Beanstalk it is undefined, so relying on it alone would silently
  // record nothing — and "no IP" on a regulated audit row is a real loss,
  // even if it beats a forged one.
  //
  // Safe by default: with TRUSTED_PROXY_COUNT unset (0), the backend
  // ignores this header entirely and uses its own socket peer. A forged
  // chain is only ever consulted once an operator has explicitly declared
  // how many hops are real.
  const inboundXff = req.headers.get('x-forwarded-for');
  const peerIp = (req as { ip?: string }).ip ?? null;
  const chain = [inboundXff, peerIp].filter(Boolean).join(', ');
  if (chain) h.set('x-forwarded-for', chain);

  h.set('authorization', `Bearer ${accessToken}`);
  return h;
}

/** Headers forwarded *from* the backend to the browser. */
function passthroughResponseHeaders(upstream: Response): Headers {
  const h = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) h.set('content-type', ct);
  const rid = upstream.headers.get('x-request-id');
  if (rid) h.set('x-request-id', rid);
  // File downloads (the finance CSV, RPT-001) carry their filename here.
  // Without it the browser names the file after the URL path and finance
  // ends up with a folder of identical "inventory.csv" files.
  //
  // Deliberately NOT forwarding ``content-length``: undici transparently
  // decompresses a gzipped upstream, so the upstream value is the COMPRESSED
  // byte count and would truncate the body. Next recomputes it correctly.
  const cd = upstream.headers.get('content-disposition');
  if (cd) h.set('content-disposition', cd);
  // We never forward upstream Set-Cookie — token cookies are owned by
  // the BFF layer, not the backend.
  return h;
}

async function attemptRefresh(): Promise<BackendTokens | null> {
  const rt = (await cookies()).get(AUTH_COOKIES.refresh)?.value;
  if (!rt) return null;
  try {
    return await backend.refresh(rt);
  } catch (err) {
    if (err instanceof BackendError) return null;
    throw err;
  }
}

async function proxy(req: NextRequest, params: { path: string[] }): Promise<NextResponse> {
  const method = req.method as Method;

  // CSRF defence in depth — reject before doing any work or touching cookies.
  if (isCrossSiteMutation(req)) {
    return NextResponse.json(CSRF_BLOCKED, { status: 403 });
  }

  const targetPath = joinPath(params.path);
  if (targetPath === null) {
    return NextResponse.json(
      { code: 'invalid_path', message: 'Invalid request path.' },
      { status: 400 },
    );
  }
  const search = req.nextUrl.search ?? '';
  const url = `${serverEnv.BACKEND_INTERNAL_URL.replace(/\/$/, '')}${targetPath}${search}`;

  const at = (await cookies()).get(AUTH_COOKIES.access)?.value;
  if (!at && !(await cookies()).get(AUTH_COOKIES.refresh)?.value) {
    // No session at all — short-circuit so we don't waste a backend hop.
    return NextResponse.json(
      { code: 'authentication_required', message: 'Not authenticated.' },
      { status: 401 },
    );
  }

  // Cache the body so we can replay it on a 401 retry. Reading a
  // NextRequest body is one-shot; an ArrayBuffer survives a replay.
  // DELETE may legitimately carry a body (e-signed deletes send
  // ``{evidence_id, reason}``), so forward it whenever one is present —
  // only GET is guaranteed body-less. Empty bodies are normalised to
  // ``undefined`` so a body-less DELETE/POST isn't sent a 0-byte payload.
  const rawBody = method === 'GET' ? undefined : await req.arrayBuffer();
  const body = rawBody && rawBody.byteLength > 0 ? rawBody : undefined;

  // ── First attempt ───────────────────────────────────────────────────
  let upstream: Response | null = null;
  if (at) {
    upstream = await fetch(url, {
      method,
      headers: forwardableHeaders(req, at),
      body,
      cache: 'no-store',
      redirect: 'manual',
    });
  }

  // ── 401 → silent refresh + retry once ───────────────────────────────
  let refreshed: BackendTokens | null = null;
  if (!upstream || upstream.status === 401) {
    refreshed = await attemptRefresh();
    if (!refreshed) {
      const res = NextResponse.json(
        { code: 'authentication_required', message: 'Session expired.' },
        { status: 401 },
      );
      await clearAuthCookies(res);
      return res;
    }
    upstream = await fetch(url, {
      method,
      headers: forwardableHeaders(req, refreshed.access_token),
      body,
      cache: 'no-store',
      redirect: 'manual',
    });
  }

  // 204 responses (e.g. logout-style endpoints) have no body.
  const upstreamBody = upstream.status === 204 ? null : await upstream.arrayBuffer();
  const res = new NextResponse(upstreamBody, {
    status: upstream.status,
    headers: passthroughResponseHeaders(upstream),
  });
  if (refreshed) {
    await setAuthCookies(res, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      accessMaxAgeSeconds: refreshed.expires_in,
    });
  }
  // A deactivated user (disabled mid-session) gets 403 ``account_disabled`` on
  // every protected call. Kill the session server-side so the token cookies
  // can't be reused — the client then bounces them to /login (see api client).
  if (upstream.status === 403 && upstreamBody) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(upstreamBody)) as { code?: string };
      if (parsed?.code === 'account_disabled') await clearAuthCookies(res);
    } catch {
      // Non-JSON 403 — leave the session as-is.
    }
  }
  return res;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await ctx.params));
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await ctx.params));
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await ctx.params));
}
export async function PUT(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await ctx.params));
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await ctx.params));
}
