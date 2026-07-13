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
import { backend, BackendError } from '@/lib/auth/backend';
import type { BackendTokens } from '@/lib/auth/types';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function joinPath(parts: string[]): string {
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

  // ``X-Forwarded-For`` — append the original client IP if Vercel / a
  // load balancer already set one; otherwise start a new chain from
  // ``req.ip`` (Next.js exposes the socket peer here in production
  // deployments; falls back to undefined in pure-Node dev).
  const existingXff = req.headers.get('x-forwarded-for');
  const clientIp =
    (req as { ip?: string }).ip ??
    req.headers.get('x-real-ip') ??
    null;
  const xff = existingXff
    ? existingXff
    : clientIp
      ? clientIp
      : null;
  if (xff) h.set('x-forwarded-for', xff);

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
  // We never forward upstream Set-Cookie — token cookies are owned by
  // the BFF layer, not the backend.
  return h;
}

async function attemptRefresh(): Promise<BackendTokens | null> {
  const rt = cookies().get(AUTH_COOKIES.refresh)?.value;
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
  const targetPath = joinPath(params.path);
  const search = req.nextUrl.search ?? '';
  const url = `${serverEnv.BACKEND_INTERNAL_URL.replace(/\/$/, '')}${targetPath}${search}`;

  const at = cookies().get(AUTH_COOKIES.access)?.value;
  if (!at && !cookies().get(AUTH_COOKIES.refresh)?.value) {
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
      clearAuthCookies(res);
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
    setAuthCookies(res, {
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
      if (parsed?.code === 'account_disabled') clearAuthCookies(res);
    } catch {
      // Non-JSON 403 — leave the session as-is.
    }
  }
  return res;
}

export async function GET(req: NextRequest, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx.params);
}
export async function POST(req: NextRequest, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx.params);
}
export async function PATCH(req: NextRequest, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx.params);
}
export async function PUT(req: NextRequest, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx.params);
}
export async function DELETE(req: NextRequest, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx.params);
}
