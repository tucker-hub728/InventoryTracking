/**
 * Maps a Cognito-issued role string onto the frontend's RBAC bucket.
 *
 * Backend roles (Cognito ``custom:role``) currently use coarse labels —
 * ``super_admin``, ``admin``, ``editor``, ``viewer``. The frontend's
 * permission system has three buckets (``admin``/``editor``/``viewer``).
 * ``super_admin`` collapses to ``admin`` until the v2 RBAC tables ship.
 */

import type { RoleId } from '@/types/auth';

const KNOWN: Record<string, RoleId> = {
  super_admin: 'admin',
  admin: 'admin',
  editor: 'editor',
  viewer: 'viewer',
};

export function mapBackendRoleToRoleId(raw: string | null | undefined): RoleId {
  if (!raw) return 'viewer';
  return KNOWN[raw.toLowerCase()] ?? 'viewer';
}
