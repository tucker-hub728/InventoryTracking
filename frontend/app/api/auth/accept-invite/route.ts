/**
 * POST /api/auth/accept-invite
 *
 * Public (the invitee has no session yet). Completes an invitation by
 * exchanging the temporary password + a chosen new password for tokens (via
 * the FastAPI backend), sets httpOnly cookies, and returns the client-safe
 * session user — mirroring /api/auth/login so the invitee is signed in
 * immediately after accepting.
 *
 * The tokens never reach the browser; only the user object does.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { backend, BackendError } from '@/lib/auth/backend';
import { setAuthCookies } from '@/lib/auth/cookies';
import { toSessionUser } from '@/lib/auth/session';

const bodySchema = z.object({
  token: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const json: unknown = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { code: 'invalid_request', message: 'Missing required fields.' },
      { status: 400 },
    );
  }

  try {
    const tokens = await backend.acceptInvite({
      token: parsed.data.token,
      password: parsed.data.password,
    });
    const me = await backend.me(tokens.access_token);

    const res = NextResponse.json({ user: toSessionUser(me) });
    setAuthCookies(res, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessMaxAgeSeconds: tokens.expires_in,
    });
    return res;
  } catch (err) {
    if (err instanceof BackendError) {
      const status = err.status >= 500 ? 502 : err.status;
      return NextResponse.json({ code: err.code, message: err.message }, { status });
    }
    return NextResponse.json(
      { code: 'unexpected_error', message: 'Could not activate your account. Please try again.' },
      { status: 500 },
    );
  }
}
