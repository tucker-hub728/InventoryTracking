/**
 * POST /api/auth/set-password
 *
 * Public (the invitee has no session yet — only the challenge stashed at login).
 * Completes the Cognito NEW_PASSWORD_REQUIRED challenge by exchanging the
 * challenge ``session`` (read from the httpOnly cookie set by /api/auth/login)
 * plus the invitee's chosen password for tokens, sets the auth cookies, clears
 * the challenge cookie, and returns the client-safe session user — mirroring
 * /api/auth/login so the invitee is signed in immediately after setting it.
 *
 * The challenge session never reaches the browser; only the user object does.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { backend, BackendError } from '@/lib/auth/backend';
import {
  AUTH_COOKIES,
  clearChallengeCookie,
  setAuthCookies,
} from '@/lib/auth/cookies';
import { CSRF_BLOCKED, isCrossSiteMutation } from '@/lib/auth/csrf';
import { toSessionUser } from '@/lib/auth/session';

const bodySchema = z.object({
  password: z.string().min(1),
});

const challengeSchema = z.object({
  session: z.string().min(1),
  email: z.string().min(1),
});

export async function POST(req: NextRequest) {
  // Defence in depth alongside SameSite=Lax — see lib/auth/csrf.ts.
  if (isCrossSiteMutation(req)) {
    return NextResponse.json(CSRF_BLOCKED, { status: 403 });
  }

  const json: unknown = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { code: 'invalid_request', message: 'A password is required.' },
      { status: 400 },
    );
  }

  // The challenge (session + email) lives in an httpOnly cookie set at login.
  const raw = req.cookies.get(AUTH_COOKIES.challenge)?.value;
  const challenge = raw ? challengeSchema.safeParse(safeJson(raw)) : null;
  if (!challenge || !challenge.success) {
    return NextResponse.json(
      {
        code: 'challenge_expired',
        message: 'Your set-password session has expired. Please sign in again.',
      },
      { status: 440 },
    );
  }

  try {
    const tokens = await backend.setPassword({
      email: challenge.data.email,
      session: challenge.data.session,
      password: parsed.data.password,
    });
    const me = await backend.me(tokens.access_token);

    const res = NextResponse.json({ user: toSessionUser(me) });
    setAuthCookies(res, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessMaxAgeSeconds: tokens.expires_in,
    });
    clearChallengeCookie(res);
    return res;
  } catch (err) {
    if (err instanceof BackendError) {
      const status = err.status >= 500 ? 502 : err.status;
      return NextResponse.json({ code: err.code, message: err.message }, { status });
    }
    return NextResponse.json(
      { code: 'unexpected_error', message: 'Could not set your password. Please try again.' },
      { status: 500 },
    );
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
