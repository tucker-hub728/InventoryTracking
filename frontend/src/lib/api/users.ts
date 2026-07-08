/**
 * Users API — wraps ``/v1/users`` (via the BFF proxy).
 *
 * Week-1: the backend user-management surface is minimal. A list
 * endpoint may not exist yet; callers should fall back to the current
 * session user when {@link usersApi.list} rejects.
 */

import { api } from './client';

export type RoleId = 'super_admin' | 'admin' | 'operator';

export interface ApiUser {
  id: string;
  email: string;
  full_name: string | null;
  first_name: string;
  last_name: string;
  role: string;
  is_active: boolean;
}

export interface UserUpdateInput {
  first_name?: string;
  last_name?: string;
  role?: RoleId;
  is_active?: boolean;
}

export const usersApi = {
  list: (opts?: { signal?: AbortSignal }) =>
    api.get<ApiUser[]>('/users', { signal: opts?.signal }),

  update: (id: string, input: UserUpdateInput) =>
    api.patch<ApiUser>(`/users/${id}`, { json: input }),
};
