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
   * Mandatory free-text rationale for the action ("correcting an erroneous
   * transfer", …). Required for every e-signature (21 CFR Part 11) and
   * stored on the audit row. The backend rejects a blank value.
   */
  comment: string;
  /**
   * Optional S3 key returned by ``uploadsApi.signature(...)``. When set,
   * the canvas-drawn signature image is stored on the audit row and
   * shown in the audit viewer alongside the typed password attestation.
   */
  signature_image_s3_key?: string;
}

export interface ReauthResponse {
  evidence_id: string;
  action: string;
  /** ISO timestamp; the UI shows a relative countdown if useful. */
  expires_at: string;
  signature_image_s3_key: string | null;
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
