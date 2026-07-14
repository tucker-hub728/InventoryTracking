/**
 * Users API — wraps ``/v1/users`` (via the BFF proxy).
 *
 * Admin surface: list the directory + edit a user's name / role / active flag.
 * Disabling a user propagates to AWS Cognito (admin_disable_user) so the
 * account can't authenticate — handled server-side by the backend.
 */

import { api } from './client';

export type RoleId = 'super_admin' | 'admin' | 'operator' | 'read_only';

/** Roles that may be assigned via edit/invite (super_admin is a fixed singleton). */
export type AssignableRole = 'admin' | 'operator' | 'read_only';

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
}

export interface UserUpdateInput {
  full_name?: string;
  role?: AssignableRole;
  is_active?: boolean;
}

export const usersApi = {
  list: (opts?: { signal?: AbortSignal }) => api.get<ApiUser[]>('/users', { signal: opts?.signal }),

  update: (id: string, input: UserUpdateInput) =>
    api.patch<ApiUser>(`/users/${id}`, { json: input }),

  setActive: (id: string, isActive: boolean) =>
    api.patch<ApiUser>(`/users/${id}`, { json: { is_active: isActive } }),
};
