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
import { setAuthCookies } from '@/lib/auth/cookies';
import { toSessionUser } from '@/lib/auth/session';

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const json: unknown = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { code: 'invalid_request', message: 'Email and password are required.' },
      { status: 400 },
    );
  }

  try {
    const tokens = await backend.login(parsed.data.email, parsed.data.password);
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
