/**
 * Invitations API — wraps ``/v1/invitations`` (via the BFF proxy).
 *
 * Admin (super-admin) surface: create / list / revoke / resend. The public
 * accept + resolve endpoints are NOT here — they run server-side through the
 * BFF (see ``lib/auth/backend.ts`` + ``app/api/auth/accept-invite``) because
 * the invitee has no session.
 */

import { api } from './client';
import type { RoleId } from './users';

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InviteInput {
  email: string;
  first_name: string;
  last_name: string;
  role: RoleId;
}

/** Returned on create/resend — carries the one-time link token. */
export interface InviteResult {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  status: InviteStatus;
  expires_at: string;
  token: string;
  accept_path: string;
  accept_url: string | null;
}

/** Directory view of an invitation. */
export interface Invitation {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  status: InviteStatus;
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

/** Compose the absolute accept link, falling back to the current origin when
 * the backend has no FRONTEND_BASE_URL configured (dev). */
export function acceptUrlFor(result: InviteResult): string {
  if (result.accept_url) return result.accept_url;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}${result.accept_path}`;
}

export const invitationsApi = {
  create: (input: InviteInput) => api.post<InviteResult>('/invitations', { json: input }),

  list: (opts?: { status?: InviteStatus; signal?: AbortSignal }) =>
    api.get<Invitation[]>('/invitations', {
      query: opts?.status ? { status: opts.status } : undefined,
      signal: opts?.signal,
    }),

  revoke: (id: string) => api.post<Invitation>(`/invitations/${id}/revoke`),

  resend: (id: string) => api.post<InviteResult>(`/invitations/${id}/resend`),
};
