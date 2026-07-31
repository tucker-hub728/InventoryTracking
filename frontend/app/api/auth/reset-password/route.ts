/**
 * POST /api/auth/reset-password
 *
 * Public — completes what /api/auth/forgot-password started, using the code
 * Cognito emailed plus a new password.
 *
 * Unlike the first step this one passes real errors through: the caller already
 * holds a code, so "that code is wrong" or "that password is too weak" tells them
 * nothing they couldn't learn by retrying, and hiding it would strand them.
 *
 * No session is minted here — on success the user is sent back to /login to sign
 * in with the new password, which keeps the one path that creates a session.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { backend, BackendError } from '@/lib/auth/backend';

const bodySchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(32),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const json: unknown = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { code: 'invalid_request', message: 'Email, code and a new password are required.' },
      { status: 400 },
    );
  }

  try {
    const result = await backend.resetPassword(parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof BackendError) {
      const status = err.status >= 500 ? 502 : err.status;
      return NextResponse.json({ code: err.code, message: err.message }, { status });
    }
    return NextResponse.json(
      { code: 'unexpected_error', message: 'Could not reset your password. Please try again.' },
      { status: 500 },
    );
  }
}
