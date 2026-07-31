/**
 * Maps a Cognito-issued role string onto the frontend's RBAC bucket.
 *
 * Backend roles (Cognito ``custom:role``) are ``super_admin``, ``admin``,
 * ``operator``, ``read_only``. The frontend's permission system has three
 * buckets (``admin``/``editor``/``viewer``), so ``super_admin`` collapses to
 * ``admin`` until the v2 RBAC tables ship.
 *
 * Because the collapse is lossy, anything that must tell a real ``super_admin``
 * apart from an ``admin`` — member management, shelf and Cold Storage creation,
 * production areas — reads ``rawRole`` via ``selectIsSuperAdmin`` instead.
 */

import type { RoleId } from '@/types/auth';

// Backend roles: super_admin / admin / operator / read_only. The frontend's
// permission buckets are admin / editor / viewer, so operator maps to the
// editor bucket and read_only to the viewer bucket.
const KNOWN: Record<string, RoleId> = {
  super_admin: 'admin',
  admin: 'admin',
  operator: 'editor',
  read_only: 'viewer',
};

export function mapBackendRoleToRoleId(raw: string | null | undefined): RoleId {
  if (!raw) return 'viewer';
  return KNOWN[raw.toLowerCase()] ?? 'viewer';
}
