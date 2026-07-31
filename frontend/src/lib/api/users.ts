/**
 * Users API — wraps ``/v1/users`` (via the BFF proxy).
 *
 * Admin surface: list the directory + edit a user's name / role / active flag.
 * Disabling a user propagates to AWS Cognito (admin_disable_user) so the
 * account can't authenticate — handled server-side by the backend.
 */

import { api } from './client';

export type RoleId = 'super_admin' | 'admin' | 'operator' | 'read_only';

/** Roles selectable when *inviting* — super_admin is never offered at invite time. */
export type AssignableRole = 'admin' | 'operator' | 'read_only';

/** Roles grantable when *editing* an existing user. Includes super_admin: the only
 * way to become one is promotion of an active, logged-in user by an existing super
 * admin (REQ-2026-07-31-ROL-005). The backend re-checks both conditions. */
export type GrantableRole = 'super_admin' | AssignableRole;

/** Display label for a backend role code. */
export const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  operator: 'Operator',
  read_only: 'Read-Only',
};

export const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;

export interface ApiUser {
  id: string;
  email: string;
  full_name: string;
  initials: string;
  role: string;
  status: string;
  is_active: boolean;
  created_at: string;
  /** Whether this user has accepted their invite and logged in, and so may be
   * promoted to super admin. Computed by the backend — don't re-derive it here. */
  can_be_promoted: boolean;
  /** Human-readable reason promotion is unavailable, when `can_be_promoted` is false. */
  promotion_blocked_reason: string | null;
}

export interface UserUpdateInput {
  /** Changing this moves the Cognito sign-in alias too — the member signs in
   * with the new address afterwards. Super-admin-only, and audited. */
  email?: string;
  full_name?: string;
  role?: GrantableRole;
  is_active?: boolean;
}

export const usersApi = {
  list: (opts?: { signal?: AbortSignal }) => api.get<ApiUser[]>('/users', { signal: opts?.signal }),

  update: (id: string, input: UserUpdateInput) =>
    api.patch<ApiUser>(`/users/${id}`, { json: input }),

  setActive: (id: string, isActive: boolean) =>
    api.patch<ApiUser>(`/users/${id}`, { json: { is_active: isActive } }),
};
