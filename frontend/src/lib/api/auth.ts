/**
 * Auth API surface that lives behind the BFF cookie session.
 *
 * Login / refresh / logout are still handled by the BFF route handlers
 * (``/api/auth/*``) because those endpoints set/clear cookies. Anything
 * the *backend* exposes under ``/v1/auth/*`` lives here.
 *
 * Right now that's just ``POST /v1/auth/reauth`` — the e-signature
 * second-factor that every GxP-significant write requires. The
 * ``useReauth()`` hook + ``PasswordReauthDialog`` build on top of this.
 */

import { api } from './client';

export interface ReauthRequestBody {
  /**
   * Stable, machine-readable action verb. The backend route that
   * consumes the evidence checks this matches its expected value
   * (e.g. ``movement.receipt``), so evidence minted for one action
   * cannot be replayed against another.
   */
  action: string;
  password: string;
  /** Optional attestation text rendered verbatim on the reauth dialog. */
  meaning?: string;
  /**
   * Optional free-text rationale for the action ("correcting an erroneous
   * transfer", …), stored on the audit row. Made optional 2026-06-29 (client
   * request); a few domain flows still require their own reason.
   */
  comment?: string;
}

export interface ReauthResponse {
  evidence_id: string;
  action: string;
  /** ISO timestamp; the UI shows a relative countdown if useful. */
  expires_at: string;
  /**
   * The rationale the operator entered, echoed back so the caller can
   * mirror it into the domain record's notes/reason (e.g. the movement
   * ledger), keeping the audit log and per-domain views in sync.
   */
  comment: string | null;
}

export const authApi = {
  reauth: (body: ReauthRequestBody) =>
    api.post<ReauthResponse>('/auth/reauth', { json: body }),
};
