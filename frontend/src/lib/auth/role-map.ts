/**
 * Maps a backend-issued role string onto the frontend's RBAC bucket.
 *
 * Week-1 reset (2026-07-06): the backend roles are exactly
 * ``super_admin`` / ``admin`` / ``operator``. Legacy labels (editor /
 * viewer) collapse to ``operator`` (least privilege that can still work)
 * until any stale tokens age out.
 */

import type { RoleId } from '@/types/auth';

const KNOWN: Record<string, RoleId> = {
  super_admin: 'super_admin',
  admin: 'admin',
  operator: 'operator',
  // Legacy fall-throughs.
  editor: 'operator',
  viewer: 'operator',
};

export function mapBackendRoleToRoleId(raw: string | null | undefined): RoleId {
  if (!raw) return 'operator';
  return KNOWN[raw.toLowerCase()] ?? 'operator';
}
