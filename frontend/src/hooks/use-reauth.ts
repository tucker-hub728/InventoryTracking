'use client';

import * as React from 'react';

import { ApiError } from '@/lib/api/client';
import { authApi, type ReauthResponse } from '@/lib/api/auth';

export interface UseReauthResult {
  /**
   * Submit the password + action and, on success, resolve with the
   * evidence id the caller passes to the write endpoint. Returns
   * ``null`` when the attempt failed (the hook stores the error
   * message for rendering); throws only on truly unexpected errors.
   *
   * ``signatureImageS3Key`` is optional — pass it after a successful
   * ``uploadSignature`` call to attach the canvas image to the audit
   * row. Omit it for headless flows.
   */
  reauth: (input: {
    password: string;
    meaning?: string;
    signatureImageS3Key?: string;
  }) => Promise<ReauthResponse | null>;
  pending: boolean;
  /** Human-readable error from the last attempt, or null if clean. */
  error: string | null;
  /** Set true when the last failure was a rate limit (UI may want to
   *  disable the submit button instead of letting the user retry). */
  rateLimited: boolean;
  reset: () => void;
}

/**
 * E-signature primitive. Pair with ``<PasswordReauthDialog>`` for the
 * UI, or call the returned ``reauth()`` directly for headless flows.
 *
 * The hook is intentionally NOT a store — every dialog instance gets
 * its own error state so two simultaneous wizards don't collide.
 */
export function useReauth(action: string): UseReauthResult {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [rateLimited, setRateLimited] = React.useState(false);

  const reauth = React.useCallback(
    async ({
      password,
      meaning,
      signatureImageS3Key,
    }: {
      password: string;
      meaning?: string;
      signatureImageS3Key?: string;
    }) => {
      setPending(true);
      setError(null);
      setRateLimited(false);
      try {
        return await authApi.reauth({
          action,
          password,
          meaning,
          signature_image_s3_key: signatureImageS3Key,
        });
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.code === 'reauth_failed') {
            setError('Incorrect password.');
          } else if (err.code === 'reauth_rate_limited') {
            setRateLimited(true);
            setError(
              'Too many failed attempts. Try again in a few minutes.',
            );
          } else if (err.code === 'authentication_required') {
            setError('Your session has expired. Sign in again.');
          } else {
            setError(err.message);
          }
        } else {
          setError('Something went wrong. Please try again.');
        }
        return null;
      } finally {
        setPending(false);
      }
    },
    [action],
  );

  const reset = React.useCallback(() => {
    setPending(false);
    setError(null);
    setRateLimited(false);
  }, []);

  return { reauth, pending, error, rateLimited, reset };
}
