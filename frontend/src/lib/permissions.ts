/**
 * Authoritative role → permission table + the ``can()`` gate.
 *
 * Week-1 reset (2026-07-06). Three roles:
 *
 *  - ``super_admin`` / ``admin`` — manage locations, items and users, and
 *    perform all transactions.
 *  - ``operator`` — may view everything operational and create
 *    transactions (receive / transfer); no master-data or user writes.
 *
 * This table is frontend-advisory (it drives nav visibility + button
 * enablement). The backend enforces the real permissions per request.
 */

import type {
  Action,
  AuthedUser,
  ResourceKey,
  Role,
  RoleId,
  RolePerms,
} from '@/types/auth';

const ALL: Record<Action, boolean> = { view: true, create: true, edit: true, delete: true };
const NONE: Record<Action, boolean> = { view: false, create: false, edit: false, delete: false };
const VIEW_ONLY: Record<Action, boolean> = { view: true, create: false, edit: false, delete: false };
const VIEW_CREATE: Record<Action, boolean> = { view: true, create: true, edit: false, delete: false };

// Super admin manages everything, including location master data + full user admin.
const superAdminPerms: RolePerms = {
  items: ALL,
  locations: ALL,
  transactions: ALL,
  users: ALL,
};

// Admin runs day-to-day: full item + transaction access. Locations and user
// roles are super-admin-managed, so both are view-only for admin.
const adminPerms: RolePerms = {
  items: ALL,
  locations: VIEW_ONLY,
  transactions: VIEW_CREATE,
  users: VIEW_ONLY,
};

const operatorPerms: RolePerms = {
  items: VIEW_ONLY,
  locations: VIEW_ONLY,
  transactions: VIEW_CREATE,
  users: NONE,
};

export const ROLES: Record<RoleId, Role> = {
  super_admin: {
    id: 'super_admin',
    name: 'Super Admin',
    description: 'Full access — manage locations, items, users and all transactions.',
    perms: superAdminPerms,
  },
  admin: {
    id: 'admin',
    name: 'Admin',
    description: 'Items, transactions and user roles. Locations are view-only.',
    perms: adminPerms,
  },
  operator: {
    id: 'operator',
    name: 'Operator',
    description: 'View inventory and record transactions (receive / transfer).',
    perms: operatorPerms,
  },
};

/** Single authoritative permission check. Safe on a null user. */
export function can(
  user: AuthedUser | null | undefined,
  resource: ResourceKey,
  action: Action,
): boolean {
  if (!user) return false;
  return Boolean(user.perms[resource]?.[action]);
}

/** Build the synthesized AuthedUser from a base user + role definition. */
export function buildAuthedUser(
  base: {
    id: string;
    name: string;
    email: string;
    role: RoleId;
    status: string;
    lastActive: string;
    initials: string;
  },
  role: Role,
): AuthedUser {
  return {
    ...base,
    status: base.status as AuthedUser['status'],
    roleName: role.name,
    perms: role.perms,
  };
}
