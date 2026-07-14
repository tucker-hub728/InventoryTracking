'use client';

import { useAuthStore } from '@/stores/auth.store';
import { can } from '@/lib/permissions';
import type { AuditAction, InventoryAction, ResourceKey, UsersAction } from '@/types/auth';

export function usePermission(resource: 'inventory', action: InventoryAction): boolean;
export function usePermission(resource: 'users', action: UsersAction): boolean;
export function usePermission(resource: 'audit', action: AuditAction): boolean;
export function usePermission(resource: ResourceKey, action: string): boolean {
  const user = useAuthStore((s) => s.user);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return can(user as any, resource as any, action as any);
}
