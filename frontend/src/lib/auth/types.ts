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

/** Tokens as returned by `/auth/login` and `/auth/refresh`. */
export interface BackendTokens {
  id_token: string | null;
  access_token: string;
  refresh_token: string | null;
  expires_in: number;
  token_type: string;
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
