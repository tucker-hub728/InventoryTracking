/**
 * Invitations API — wraps ``/v1/invitations`` (via the BFF proxy).
 *
 * Admin (super-admin) surface: create / list / revoke / resend. Cognito emails
 * the invitee a temporary password; onboarding is completed by the invitee via
 * the login → set-password flow, so there is no public accept endpoint here.
 */

import { api } from './client';
import type { AssignableRole } from './users';

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InviteInput {
  email: string;
  first_name: string;
  last_name: string;
  role: AssignableRole;
}

/** Returned on create/resend. Carries no credential — Cognito emails the invitee
 * their temporary password directly, so it is never exposed in the response. */
export interface InviteResult {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  status: InviteStatus;
  expires_at: string;
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

export interface ListInvitationsParams {
  status?: InviteStatus;
  /** Free-text over email + first/last name. */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface InvitationListResponse {
  items: Invitation[];
  total: number;
  limit: number;
  offset: number;
}

export const invitationsApi = {
  create: (input: InviteInput) => api.post<InviteResult>('/invitations', { json: input }),

  list: (params: ListInvitationsParams = {}, opts?: { signal?: AbortSignal }) =>
    api.get<InvitationListResponse>('/invitations', {
      query: {
        status: params.status,
        q: params.q,
        limit: params.limit,
        offset: params.offset,
      },
      signal: opts?.signal,
    }),

  /** Hard-deletes the invitation + reserved identity (204 No Content). */
  revoke: (id: string) => api.post<void>(`/invitations/${id}/revoke`),

  resend: (id: string) => api.post<InviteResult>(`/invitations/${id}/resend`),
};
