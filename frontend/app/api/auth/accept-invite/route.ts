/**
 * POST /api/auth/accept-invite
 *
 * Public counterpart to /api/auth/login for the invite flow. Takes the link
 * token + a chosen password, has the backend set the password and materialise
 * the account, then sets the httpOnly session cookies and returns the
 * client-safe session user — so the invitee lands logged in.
 *
 * This deliberately does NOT go through the /api/v1 proxy: the invitee has no
 * session cookie yet, and that proxy short-circuits unauthenticated calls.
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
      { code: 'invalid_request', message: 'A token and password are required.' },
      { status: 400 },
    );
  }

  try {
    const tokens = await backend.acceptInvite(parsed.data.token, parsed.data.password);
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
      // Pass through 4xx codes (invalid/expired token, weak password, etc.);
      // collapse 5xx to a generic gateway error.
      const status = err.status >= 500 ? 502 : err.status;
      return NextResponse.json({ code: err.code, message: err.message }, { status });
    }
    return NextResponse.json(
      { code: 'unexpected_error', message: 'Could not activate your account. Please try again.' },
      { status: 500 },
    );
  }
}
