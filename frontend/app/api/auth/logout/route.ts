/**
 * POST /api/auth/logout
 *
 * Clears the session cookies. We don't call Cognito's GlobalSignOut here
 * because that would invalidate the refresh token across *every* device
 * the user is signed in on — sign-out from one browser shouldn't touch
 * the others. The local cookies are gone; if a stolen access token were
 * still in play it expires within its TTL.
 */

import { NextResponse } from 'next/server';

import { clearAuthCookies } from '@/lib/auth/cookies';

export async function POST() {
  const res = new NextResponse(null, { status: 204 });
  clearAuthCookies(res);
  return res;
}
