/**
 * Shared session shapes — used by both server (route handlers, middleware)
 * and client (auth store, components). Keep this file dependency-free so
 * it doesn't drag a server-only import into the client bundle.
 */

import type { RoleId } from '@/types/auth';

/** Raw user identity as returned by the backend `/auth/me`. */
export interface BackendMe {
  sub: string;
  username: string;
  email: string | null;
  full_name: string | null;
  initials: string | null;
  role: string | null;
}

/** Tokens as returned by `/auth/login`, `/auth/refresh` and `/auth/set-password`. */
export interface BackendTokens {
  id_token: string | null;
  access_token: string;
  refresh_token: string | null;
  expires_in: number;
  token_type: string;
}

/** `/auth/login` alternative: an invited user signing in with their temporary
 * password must set a real one before a session is minted. ``session`` is a
 * short-lived Cognito challenge continuation token (NOT an access token). */
export interface BackendNewPasswordChallenge {
  challenge: 'NEW_PASSWORD_REQUIRED';
  session: string;
  email: string;
}

/** `/auth/login` returns tokens on success, or a set-password challenge. */
export type BackendLoginResult = BackendTokens | BackendNewPasswordChallenge;

export function isNewPasswordChallenge(
  r: BackendLoginResult,
): r is BackendNewPasswordChallenge {
  return (r as BackendNewPasswordChallenge).challenge === 'NEW_PASSWORD_REQUIRED';
}

/** Public session info — safe to ship to the client. Never includes tokens. */
export interface SessionUser {
  sub: string;
  email: string;
  fullName: string;
  initials: string;
  /** Cognito-issued role string, e.g. ``super_admin``. */
  rawRole: string;
  /** Frontend RBAC bucket this user maps to. */
  roleId: RoleId;
}
