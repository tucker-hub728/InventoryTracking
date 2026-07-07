'use client';

import { useAuthStore } from '@/stores/auth.store';
import { can } from '@/lib/permissions';
import type { Action, ResourceKey } from '@/types/auth';

/** Reactive permission check bound to the current session user. */
export function usePermission(resource: ResourceKey, action: Action): boolean {
  const user = useAuthStore((s) => s.user);
  return can(user, resource, action);
}
