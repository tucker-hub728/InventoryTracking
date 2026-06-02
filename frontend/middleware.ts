/**
 * Edge middleware — coarse gate for app-shell routes.
 *
 * We only check for *presence* of cookies here, not validity. Validating
 * tokens at the edge would require pulling in the JWKS client (heavy, and
 * not edge-runtime-friendly) and would duplicate what the backend already
 * does on every API call. The fine-grained check happens server-side in
 * the BFF route handlers and the AuthGuard's call to /api/auth/me.
 *
 * Behaviour:
 *   - Unauthed visitor → /login (preserves `?next=` so post-login redirect works)
 *   - Authed visitor on /login → /inventory
 *
 * The matcher excludes API routes, static assets, and the public auth
 * entry-points so this middleware adds zero overhead to those paths.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { AUTH_COOKIES } from '@/lib/auth/cookies';

// Public routes — no auth required.
const PUBLIC_PATHS = new Set<string>(['/login', '/accept-invite', '/forgot-password']);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // accept-invite uses dynamic segments
  return pathname.startsWith('/accept-invite/');
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // The refresh cookie is our "is there a session at all" signal. It outlives
  // the access cookie by a wide margin, so its presence is the right proxy
  // for "the user is logged in and we should try to authenticate them".
  const hasSession = Boolean(req.cookies.get(AUTH_COOKIES.refresh)?.value);

  if (!hasSession && !isPublic(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    if (pathname !== '/') url.searchParams.set('next', pathname + (search ?? ''));
    return NextResponse.redirect(url);
  }

  if (hasSession && pathname === '/login') {
    const url = req.nextUrl.clone();
    url.pathname = '/inventory';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Skip Next internals, the BFF auth routes (so they can clear cookies on
  // failure without bouncing), and static assets.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
