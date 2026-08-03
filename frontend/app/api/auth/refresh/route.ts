/**
 * POST /api/auth/refresh
 *
 * Reads the refresh token cookie, calls the backend, and writes a fresh
 * access cookie. Cognito does NOT return a new refresh token on this call,
 * so the existing one stays in place until it hits its own TTL.
 *
 * Most clients won't call this directly — ``readSession`` does a silent
 * refresh on /me when the access cookie has expired. This route exists
 * for manual / client-driven retries (e.g. after a 401 from a downstream
 * API call) and for unit tests.
 */

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import { backend, BackendError } from '@/lib/auth/backend';
import { AUTH_COOKIES, clearAuthCookies, setAuthCookies } from '@/lib/auth/cookies';
import { CSRF_BLOCKED, isCrossSiteMutation } from '@/lib/auth/csrf';

export async function POST(req: NextRequest) {
  if (isCrossSiteMutation(req)) {
    return NextResponse.json(CSRF_BLOCKED, { status: 403 });
  }

  const rt = cookies().get(AUTH_COOKIES.refresh)?.value;
  if (!rt) {
    return NextResponse.json(
      { code: 'no_session', message: 'No refresh token on file.' },
      { status: 401 },
    );
  }

  try {
    const tokens = await backend.refresh(rt);
    const res = NextResponse.json({ ok: true });
    setAuthCookies(res, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessMaxAgeSeconds: tokens.expires_in,
    });
    return res;
  } catch (err) {
    // Refresh failure is terminal — wipe the cookies so the next request
    // gets a clean 401 instead of looping on a stale token.
    const res = NextResponse.json(
      {
        code: err instanceof BackendError ? err.code : 'refresh_failed',
        message:
          err instanceof BackendError ? err.message : 'Could not refresh session.',
      },
      { status: 401 },
    );
    clearAuthCookies(res);
    return res;
  }
}
