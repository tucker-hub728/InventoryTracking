/**
 * POST /api/auth/forgot-password
 *
 * Public — the caller is locked out, so there is no session to require. Asks the
 * backend to have Cognito email a reset code.
 *
 * Mints no cookies and returns no tokens: this step only starts the reset. The
 * response is deliberately identical whether or not the address has an account,
 * so the endpoint can't be used to enumerate members — the backend enforces that
 * too, and this handler is careful not to leak the difference through a status
 * code either.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { backend, BackendError } from '@/lib/auth/backend';

const bodySchema = z.object({
  email: z.string().email(),
});

const GENERIC_OK = {
  message:
    'If that address belongs to an account, a reset code is on its way. The code expires shortly.',
};

export async function POST(req: NextRequest) {
  const json: unknown = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { code: 'invalid_request', message: 'A valid email address is required.' },
      { status: 400 },
    );
  }

  try {
    await backend.forgotPassword(parsed.data.email);
  } catch (err) {
    // Surface only infrastructure failures. Anything the backend classifies as a
    // client-side problem (unknown address, throttled, unverified) collapses into
    // the same success shape — telling the caller which one it was is precisely
    // the enumeration leak this flow avoids.
    if (err instanceof BackendError && err.status >= 500) {
      return NextResponse.json(
        { code: 'unexpected_error', message: 'Could not start the reset. Please try again.' },
        { status: 502 },
      );
    }
  }
  return NextResponse.json(GENERIC_OK);
}
