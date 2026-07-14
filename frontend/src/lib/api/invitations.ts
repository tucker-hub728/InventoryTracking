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

/** Returned on create/resend. ``temporary_password`` is populated only in local
 * dev (cognito-local can't deliver mail, so the admin UI shows it for testing);
 * it is always null in production, where Cognito emails it. */
export interface InviteResult {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  status: InviteStatus;
  expires_at: string;
  temporary_password: string | null;
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

export const invitationsApi = {
  create: (input: InviteInput) => api.post<InviteResult>('/invitations', { json: input }),

  list: (opts?: { status?: InviteStatus; signal?: AbortSignal }) =>
    api.get<Invitation[]>('/invitations', {
      query: opts?.status ? { status: opts.status } : undefined,
      signal: opts?.signal,
    }),

  /** Hard-deletes the invitation + reserved identity (204 No Content). */
  revoke: (id: string) => api.post<void>(`/invitations/${id}/revoke`),

  resend: (id: string) => api.post<InviteResult>(`/invitations/${id}/resend`),
};
