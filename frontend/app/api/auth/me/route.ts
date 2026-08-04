/**
 * GET /api/auth/me
 *
 * Returns the current session user, performing a silent refresh if the
 * access cookie has expired but a refresh cookie is still valid. The
 * tokens themselves never leave the server.
 *
 * 200 → `{ user }` (and possibly Set-Cookie for refreshed access token)
 * 401 → `{ user: null }` and cleared cookies
 */

import { NextResponse } from 'next/server';

import { clearAuthCookies } from '@/lib/auth/cookies';
import { applyRefreshedCookies, readSession } from '@/lib/auth/session';

export async function GET() {
  try {
    const { user, refreshedTokens } = await readSession();
    if (!user) {
      const res = NextResponse.json({ user: null }, { status: 401 });
      await clearAuthCookies(res);
      return res;
    }
    const res = NextResponse.json({ user });
    // Must be awaited: the Set-Cookie is attached inside, and returning `res`
    // first would drop a silently-refreshed access token and bounce the user
    // to /login on their next request.
    await applyRefreshedCookies(res, refreshedTokens);
    return res;
  } catch {
    const res = NextResponse.json(
      { code: 'session_error', message: 'Could not resolve session.', user: null },
      { status: 500 },
    );
    return res;
  }
}
