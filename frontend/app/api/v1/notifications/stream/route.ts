/**
 * Streaming BFF route for the notification stream (NOTIF-001).
 *
 * This exists because the catch-all proxy at `app/api/v1/[...path]/route.ts`
 * cannot stream: it reads the upstream response with `await
 * upstream.arrayBuffer()`, which waits for the body to finish. For a
 * server-sent-events endpoint the body never finishes, so routing the stream
 * through it would hang until the connection timed out and then deliver
 * everything at once.
 *
 * Next resolves static segments before catch-alls, so this file wins
 * `/api/v1/notifications/stream` automatically and the catch-all keeps every
 * other `/api/v1/*` path unchanged.
 *
 * Everything else is deliberately identical to the catch-all: the access token
 * lives in an HttpOnly cookie the browser cannot read, so the token is attached
 * here, server-side, and a 401 triggers one silent refresh and a replay. That
 * reuse is the whole reason this feature is SSE and not a WebSocket — a socket
 * could not have gone through this layer at all.
 */

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import { serverEnv } from '@/env';
import { AUTH_COOKIES, clearAuthCookies, setAuthCookies } from '@/lib/auth/cookies';
import { backend, BackendError } from '@/lib/auth/backend';
import type { BackendTokens } from '@/lib/auth/types';

// The Node runtime, explicitly. The edge runtime would also stream, but the
// auth helpers this shares with the catch-all are Node-only.
export const runtime = 'nodejs';
// Never prerender or cache — this is a live connection, not a document.
export const dynamic = 'force-dynamic';

const UPSTREAM_PATH = '/notifications/stream';

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

function upstreamHeaders(req: NextRequest, accessToken: string): Headers {
  const h = new Headers();
  h.set('accept', 'text/event-stream');
  // Ask for no compression end to end. The backend strips this header for the
  // stream path anyway (see `app/middlewares/no_compress.py`), but saying it
  // here means any hop in between is told too — gzip buffers a stream and the
  // client would sit staring at nothing.
  h.set('accept-encoding', 'identity');
  const rid = req.headers.get('x-request-id');
  if (rid) h.set('x-request-id', rid);
  h.set('authorization', `Bearer ${accessToken}`);
  return h;
}

function streamHeaders(): Headers {
  const h = new Headers();
  h.set('content-type', 'text/event-stream; charset=utf-8');
  h.set('cache-control', 'no-cache, no-transform');
  h.set('connection', 'keep-alive');
  // Tells nginx not to sit on frames waiting for a full buffer.
  h.set('x-accel-buffering', 'no');
  return h;
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = `${serverEnv.BACKEND_INTERNAL_URL.replace(/\/$/, '')}${UPSTREAM_PATH}`;

  const jar = await cookies();
  const at = jar.get(AUTH_COOKIES.access)?.value;
  if (!at && !jar.get(AUTH_COOKIES.refresh)?.value) {
    return NextResponse.json(
      { code: 'authentication_required', message: 'Not authenticated.' },
      { status: 401 },
    );
  }

  // `duplex: 'half'` is required by undici for a request whose response is
  // consumed as a stream. `signal` propagates the browser closing the tab all
  // the way to the backend, so the generator there stops rather than writing
  // into a socket nobody is reading.
  const init: RequestInit = {
    method: 'GET',
    cache: 'no-store',
    redirect: 'manual',
    signal: req.signal,
  };

  let upstream: Response | null = null;
  if (at) {
    upstream = await fetch(url, { ...init, headers: upstreamHeaders(req, at) });
  }

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
      ...init,
      headers: upstreamHeaders(req, refreshed.access_token),
    });
  }

  if (!upstream.ok || !upstream.body) {
    // Forward the failure as JSON rather than as an empty stream. An
    // EventSource that receives a non-2xx gives up permanently instead of
    // retrying, which is the correct outcome for a 403 and avoids a client
    // reconnecting every second against a permission it will never be granted.
    const text = await upstream.text().catch(() => '');
    return new NextResponse(text || null, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  }

  const res = new NextResponse(upstream.body, {
    status: 200,
    headers: streamHeaders(),
  });
  if (refreshed) {
    await setAuthCookies(res, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      accessMaxAgeSeconds: refreshed.expires_in,
    });
  }
  return res;
}
