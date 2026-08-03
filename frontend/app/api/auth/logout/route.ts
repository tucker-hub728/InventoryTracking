/**
 * POST /api/auth/logout
 *
 * Clears the session cookies. We don't call Cognito's GlobalSignOut here
 * because that would invalidate the refresh token across *every* device
 * the user is signed in on — sign-out from one browser shouldn't touch
 * the others. The local cookies are gone; if a stolen access token were
 * still in play it expires within its TTL.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { clearAuthCookies } from '@/lib/auth/cookies';
import { CSRF_BLOCKED, isCrossSiteMutation } from '@/lib/auth/csrf';

export async function POST(req: NextRequest) {
  // Forced logout is only a nuisance rather than a breach, but the guard is
  // uniform across every mutating auth route so there is no "which ones did
  // we cover?" question later.
  if (isCrossSiteMutation(req)) {
    return NextResponse.json(CSRF_BLOCKED, { status: 403 });
  }

  const res = new NextResponse(null, { status: 204 });
  clearAuthCookies(res);
  return res;
}
