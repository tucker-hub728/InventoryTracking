/**
 * POST /api/auth/login
 *
 * Exchanges email + password (via the FastAPI backend) for tokens, sets
 * httpOnly cookies for the access + refresh tokens, and returns the
 * client-safe session user.
 *
 * The tokens never leave the server — the only thing the browser sees is
 * the user object. Subsequent API traffic rides the same cookies.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { backend, BackendError } from '@/lib/auth/backend';
import { setAuthCookies, setChallengeCookie } from '@/lib/auth/cookies';
import { CSRF_BLOCKED, isCrossSiteMutation } from '@/lib/auth/csrf';
import { toSessionUser } from '@/lib/auth/session';
import { isNewPasswordChallenge } from '@/lib/auth/types';

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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
      { code: 'invalid_request', message: 'Email and password are required.' },
      { status: 400 },
    );
  }

  try {
    const result = await backend.login(parsed.data.email, parsed.data.password);

    // Invited user's first sign-in with the temporary password: stash the
    // challenge server-side and tell the client to go set a real password. No
    // session is minted yet.
    if (isNewPasswordChallenge(result)) {
      const res = NextResponse.json({
        challenge: 'NEW_PASSWORD_REQUIRED' as const,
        email: result.email,
      });
      setChallengeCookie(res, { session: result.session, email: result.email });
      return res;
    }

    const me = await backend.me(result.access_token);

    const res = NextResponse.json({ user: toSessionUser(me) });
    setAuthCookies(res, {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      accessMaxAgeSeconds: result.expires_in,
    });
    return res;
  } catch (err) {
    if (err instanceof BackendError) {
      // Pass through 4xx codes; collapse 5xx to a generic message.
      const status = err.status >= 500 ? 502 : err.status;
      return NextResponse.json(
        { code: err.code, message: err.message },
        { status },
      );
    }
    return NextResponse.json(
      { code: 'unexpected_error', message: 'Sign-in failed. Please try again.' },
      { status: 500 },
    );
  }
}
