/**
 * Server-side client for the FastAPI auth endpoints.
 *
 * Lives behind the BFF route handlers in ``app/api/auth/*``. Never imported
 * from a client component — its base URL is the docker-internal hostname,
 * which the browser can't resolve.
 */

// Server-only by convention — uses serverEnv values that are not exposed
// to the browser. Never import from a client component.
import { serverEnv } from '@/env';
import type { BackendLoginResult, BackendMe, BackendTokens } from './types';

export class BackendError extends Error {
  constructor(
    public readonly status: number,
    /** Domain code from the backend envelope, e.g. ``authentication_required``. */
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

interface ErrorEnvelope {
  code?: string;
  message?: string;
  detail?: string;
}

async function call<T>(
  path: string,
  init: RequestInit & { body?: string } = {},
): Promise<T> {
  const url = `${serverEnv.BACKEND_INTERNAL_URL.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const resp = await fetch(url, {
    ...init,
    headers,
    // BFF traffic is always private and short-lived — never cache.
    cache: 'no-store',
  });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as ErrorEnvelope;
    throw new BackendError(
      resp.status,
      body.code ?? 'backend_error',
      body.message ?? body.detail ?? resp.statusText,
    );
  }
  // 204 No Content (e.g. /confirm) doesn't have a body.
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export const backend = {
  /** Returns tokens on success, or a NEW_PASSWORD_REQUIRED challenge when an
   * invited user signs in with their temporary password. */
  login: (email: string, password: string) =>
    call<BackendLoginResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  refresh: (refreshToken: string) =>
    call<BackendTokens>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    }),

  me: (accessToken: string) =>
    call<BackendMe>('/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),

  /** Public — complete the first-login NEW_PASSWORD_REQUIRED challenge. ``session``
   * is the challenge token from login; ``password`` is the invitee's chosen one.
   * Returns a fresh token set so the BFF can mint a session, same as login. */
  setPassword: (input: { email: string; session: string; password: string }) =>
    call<BackendTokens>('/auth/set-password', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
