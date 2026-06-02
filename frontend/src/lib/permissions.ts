import type {
  AuditAction,
  AuthedUser,
  InventoryAction,
  ResourceKey,
  Role,
  RoleId,
  UsersAction,
} from '@/types/auth';

/**
 * Single authoritative permission check.
 *
 * Usage:
 *   can(user, 'inventory', 'edit')
 *   can(user, 'audit', 'export')
 *
 * Returns false safely if user is null/undefined so we don't have to
 * sprinkle optional-chains at every call site.
 */
export function can(
  user: AuthedUser | null | undefined,
  resource: 'inventory',
  action: InventoryAction,
): boolean;
export function can(
  user: AuthedUser | null | undefined,
  resource: 'users',
  action: UsersAction,
): boolean;
export function can(
  user: AuthedUser | null | undefined,
  resource: 'audit',
  action: AuditAction,
): boolean;
export function can(
  user: AuthedUser | null | undefined,
  resource: ResourceKey,
  action: string,
): boolean {
  if (!user) return false;
  const bucket = user.perms[resource] as unknown as Record<string, boolean> | undefined;
  return Boolean(bucket?.[action]);
}

/** Build the synthesized AuthedUser from a base user + role definition. */
export function buildAuthedUser(
  base: { id: string; name: string; email: string; role: RoleId; status: string; lastActive: string; initials: string },
  role: Role,
): AuthedUser {
  return {
    ...base,
    status: base.status as AuthedUser['status'],
    roleName: role.name,
    perms: role.perms,
  };
}
