/**
 * RBAC types — Week-1 reset (2026-07-06).
 *
 * Roles are now exactly ``super_admin`` / ``admin`` / ``operator``.
 * Permissions are a flat map of resource → action → boolean. The
 * authoritative role → perms table lives in ``@/lib/permissions``.
 */

export type RoleId = 'super_admin' | 'admin' | 'operator';
export type UserStatus = 'active' | 'suspended' | 'invited';

/** Resources the UI gates visibility / affordances on. */
export type ResourceKey = 'items' | 'locations' | 'transactions' | 'users';

/** Actions a role may hold against a resource. */
export type Action = 'view' | 'create' | 'edit' | 'delete';

export type ResourcePerms = Record<Action, boolean>;
export type RolePerms = Record<ResourceKey, ResourcePerms>;

export interface Role {
  id: RoleId;
  name: string;
  description: string;
  perms: RolePerms;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: RoleId;
  status: UserStatus;
  lastActive: string;
  initials: string;
}

export interface AuthedUser extends User {
  roleName: string;
  perms: RolePerms;
}
