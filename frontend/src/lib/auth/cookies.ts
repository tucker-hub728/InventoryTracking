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

function baseOpts(maxAgeSeconds: number): CookieOpts {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export function setAuthCookies(
  res: NextResponse,
  tokens: { accessToken: string; refreshToken: string | null; accessMaxAgeSeconds?: number },
): void {
  res.cookies.set(
    AUTH_COOKIES.access,
    tokens.accessToken,
    baseOpts(tokens.accessMaxAgeSeconds ?? serverEnv.ACCESS_TOKEN_TTL_SECONDS),
  );
  // Cognito only returns a refresh token on the initial login — on refresh
  // it omits it and the client keeps reusing the original until expiry.
  if (tokens.refreshToken) {
    res.cookies.set(
      AUTH_COOKIES.refresh,
      tokens.refreshToken,
      baseOpts(serverEnv.REFRESH_TOKEN_TTL_SECONDS),
    );
  }
}

export function clearAuthCookies(res: NextResponse): void {
  // maxAge=0 explicitly invalidates; setting an empty value alone leaves
  // some browsers honouring the previous expiry.
  const expired = { ...baseOpts(0), maxAge: 0 };
  res.cookies.set(AUTH_COOKIES.access, '', expired);
  res.cookies.set(AUTH_COOKIES.refresh, '', expired);
}

/** Stash the first-login challenge (session + email) in a short-lived httpOnly
 * cookie so the set-password step can complete it without the challenge token
 * ever touching the browser. */
export function setChallengeCookie(
  res: NextResponse,
  challenge: { session: string; email: string },
): void {
  res.cookies.set(
    AUTH_COOKIES.challenge,
    JSON.stringify(challenge),
    baseOpts(CHALLENGE_MAX_AGE_SECONDS),
  );
}

export function clearChallengeCookie(res: NextResponse): void {
  res.cookies.set(AUTH_COOKIES.challenge, '', { ...baseOpts(0), maxAge: 0 });
}
