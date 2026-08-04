/**
 * Cookie naming + attribute policy for the BFF session.
 *
 * - ``AT`` and ``RT`` are both httpOnly so client JS can't read them.
 * - ``sameSite=lax`` allows top-level navigations (back-button, magic-link
 *   confirms) while blocking cross-site CSRF on form posts.
 * - ``secure`` is on in production; off in dev so localhost (http) works.
 * - Both cookies use ``path=/`` so middleware can see them on any route.
 *   The RT *could* be scoped to ``/api/auth`` for defence in depth, but
 *   then middleware can't tell "logged-in but access expired" from
 *   "logged out", and we'd have to maintain a separate marker cookie.
 *   Single-path + httpOnly is the right trade-off for this app.
 */

import { headers } from 'next/headers';
import { type NextResponse } from 'next/server';

import { serverEnv } from '@/env';

export const AUTH_COOKIES = {
  access: 'cellready_at',
  refresh: 'cellready_rt',
  /** Short-lived carrier for the Cognito NEW_PASSWORD_REQUIRED challenge
   * (session + email), set at login and consumed by /api/auth/set-password.
   * httpOnly so the challenge token never reaches client JS. */
  challenge: 'cellready_pw_challenge',
} as const;

// The challenge continuation token is only valid for a few minutes on Cognito's
// side; give the cookie a matching short lifetime.
const CHALLENGE_MAX_AGE_SECONDS = 15 * 60;

const isProd = process.env.NODE_ENV === 'production';

interface CookieOpts {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
}

/**
 * Whether the session cookie should carry `Secure`.
 *
 * The original was `secure: NODE_ENV === 'production'`, which tied a transport
 * property to a build flag: any non-production build — a staging box, a
 * preview deploy, a prod image started with NODE_ENV unset — handed out
 * session cookies with no `Secure`, so they would ride a plain http request.
 *
 * The fix is "prod is always Secure, and non-prod is Secure too when the
 * request actually arrived over TLS" — never the other way round. That
 * asymmetry is deliberate and is the whole subtlety here:
 *
 *   In this deployment the viewer→CloudFront hop is HTTPS but CloudFront→
 *   origin is plain HTTP (`OriginProtocolPolicy: http-only`), so the proto
 *   header arriving at this process says `http` even though the user is on
 *   an https:// URL. Deciding purely from that header would DROP `Secure`
 *   in production — the exact opposite of the intent. So production short-
 *   circuits to true and the header is only ever used to *upgrade* a
 *   non-production environment, never to downgrade.
 *
 * Trusting a client-settable header for the upgrade is acceptable because the
 * worst case is a cookie marked Secure when it needn't be. Contrast VR-011,
 * where a forged header would corrupt the Part 11 audit trail — not trusted.
 */
async function isSecureRequest(): Promise<boolean> {
  // Production always sits behind TLS at the edge. Never downgrade.
  // Checked first so the common case needs no header read at all.
  if (isProd) return true;

  try {
    // `headers()` is async as of Next 15. The codemod left an
    // `UnsafeUnwrappedHeaders` cast here; that shim is deprecated and warns
    // at runtime, so the whole cookie-writing chain is genuinely async
    // instead. Every caller is already an async route handler, so this
    // costs nothing.
    const h = await headers();
    // `CloudFront-Forwarded-Proto` records the VIEWER's scheme, which is what
    // we care about; `X-Forwarded-Proto` is the nearest-hop scheme and may be
    // http at the origin even on an https site.
    const cf = h.get('cloudfront-forwarded-proto');
    if (cf) return cf.trim() === 'https';
    const proto = h.get('x-forwarded-proto');
    if (proto) return proto.split(',')[0]?.trim() === 'https';
  } catch {
    // headers() throws outside a request scope (unit tests, build-time
    // evaluation). Non-prod default.
    return false;
  }
  // No proxy header and not production: local http dev.
  return false;
}

async function baseOpts(maxAgeSeconds: number): Promise<CookieOpts> {
  return {
    httpOnly: true,
    secure: await isSecureRequest(),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export async function setAuthCookies(
  res: NextResponse,
  tokens: { accessToken: string; refreshToken: string | null; accessMaxAgeSeconds?: number },
): Promise<void> {
  res.cookies.set(
    AUTH_COOKIES.access,
    tokens.accessToken,
    await baseOpts(tokens.accessMaxAgeSeconds ?? serverEnv.ACCESS_TOKEN_TTL_SECONDS),
  );
  // Cognito only returns a refresh token on the initial login — on refresh
  // it omits it and the client keeps reusing the original until expiry.
  if (tokens.refreshToken) {
    res.cookies.set(
      AUTH_COOKIES.refresh,
      tokens.refreshToken,
      await baseOpts(serverEnv.REFRESH_TOKEN_TTL_SECONDS),
    );
  }
}

export async function clearAuthCookies(res: NextResponse): Promise<void> {
  // maxAge=0 explicitly invalidates; setting an empty value alone leaves
  // some browsers honouring the previous expiry.
  const expired = { ...(await baseOpts(0)), maxAge: 0 };
  res.cookies.set(AUTH_COOKIES.access, '', expired);
  res.cookies.set(AUTH_COOKIES.refresh, '', expired);
}

/** Stash the first-login challenge (session + email) in a short-lived httpOnly
 * cookie so the set-password step can complete it without the challenge token
 * ever touching the browser. */
export async function setChallengeCookie(
  res: NextResponse,
  challenge: { session: string; email: string },
): Promise<void> {
  res.cookies.set(
    AUTH_COOKIES.challenge,
    JSON.stringify(challenge),
    await baseOpts(CHALLENGE_MAX_AGE_SECONDS),
  );
}

export async function clearChallengeCookie(res: NextResponse): Promise<void> {
  res.cookies.set(AUTH_COOKIES.challenge, '', { ...(await baseOpts(0)), maxAge: 0 });
}
