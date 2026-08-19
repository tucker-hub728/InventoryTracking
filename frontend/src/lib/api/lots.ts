/**
 * Lots API — wraps ``/api/v1/lots`` and ``/api/v1/items/{id}/lots``.
 *
 * Two surfaces:
 *
 *   * ``list({ itemId? })``  — admin list page, can be scoped to a single
 *     item via the query param (`/lots?item_id=...`).
 *   * ``listForItem(itemId)`` — the item-detail lot picker, hits
 *     `/items/{id}/lots`. 404s if the item doesn't exist instead of
 *     returning an ambiguous empty list.
 *   * ``create(itemId, input)`` — admin-side lot creation. Receipts will
 *     create lots inline via the movements module (next chunks).
 */

import { api } from './client';

// Two core lot statuses (the client's order model). "Quarantine" was
// explicitly rejected; expiry is date-driven (expiration_date), not a status.
export type LotStatus = 'on_order' | 'available';

export const LOT_STATUS_OPTIONS: { code: LotStatus; label: string }[] = [
  { code: 'available', label: 'Available' },
  { code: 'on_order', label: 'On Order' },
];

export const LOT_STATUS_LABEL: Record<LotStatus, string> = Object.fromEntries(
  LOT_STATUS_OPTIONS.map((o) => [o.code, o.label]),
) as Record<LotStatus, string>;

/**
 * The release state of a batch (REQ-2026-07-31-STS-001).
 *
 * A different axis from {@link LotStatus}, which is procurement — a lot is
 * routinely `available` AND `quarantine` at the same time. `null` means no
 * release workflow applies: consumables and raw materials never carry one, and
 * the UI shows nothing at all for them rather than an "n/a" badge.
 *
 * It is a LABEL. It blocks no transfer, issue, kit or shipment (client
 * 2026-08-17) — the requirement is visibility, and STS-003 forbids altering
 * existing LN2 behaviour.
 */
export type LotReleaseState = 'quarantine' | 'qc_hold' | 'released' | 'rejected';

/** Ordered as the workflow reads: held, under review, then the two outcomes. */
export const RELEASE_STATE_OPTIONS: {
  code: LotReleaseState;
  label: string;
  /** What choosing this one asserts — shown under the option when signing. */
  meaning: string;
}[] = [
  { code: 'quarantine', label: 'Quarantine', meaning: 'Held pending a release decision.' },
  { code: 'qc_hold', label: 'QC Hold', meaning: 'Under active investigation or retest.' },
  { code: 'released', label: 'Released', meaning: 'Cleared for use.' },
  { code: 'rejected', label: 'Rejected', meaning: 'Failed. Not to be used.' },
];

/**
 * The UI calls this concept **"Quality status"**; the code, the API and the
 * column all still say ``release_state``. That is deliberate, not drift.
 *
 * "Release state" named only one of the four outcomes — a batch can equally be
 * quarantined, held or rejected — so the label was changed (client 2026-08-19).
 * The identifiers were not: ``lot.release_state`` is the e-signature verb
 * standing behind signatures that are already recorded, and renaming it would
 * either orphan them or require rewriting an append-only table. The DB column
 * matches the API, the API matches the client, and only the words a person
 * reads changed.
 */
export const RELEASE_STATE_LABEL: Record<LotReleaseState, string> = Object.fromEntries(
  RELEASE_STATE_OPTIONS.map((o) => [o.code, o.label]),
) as Record<LotReleaseState, string>;

export interface Lot {
  id: string;
  item_id: string;
  lot_number: string;
  supplier_id: string | null;
  supplier_name: string | null;
  /** Convenience joined from items for the admin list. */
  item_number: string | null;
  item_description: string | null;
  manufacture_date: string | null;
  expiration_date: string | null;
  status: LotStatus;
  /** Release state, or null when no release workflow applies. */
  release_state: LotReleaseState | null;
  notes: string | null;
  // ── Receipt Admin v2 ──────────────────────────────────────────────
  /** Price paid for this lot (Postgres NUMERIC → string), captured at receipt. */
  unit_price_amount: string | null;
  /** Manual PO text (no PO-system integration). */
  po_reference: string | null;
  /** The intake (receipt transaction) that created this lot, if any. */
  receipt_transaction_id: string | null;
  /** Split lineage — set on child lots produced by a split receipt. */
  parent_lot_id: string | null;
  /** Ordered qty captured at intake (planning data; whole units, integer). */
  ordered_qty: number | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string;
  updated_by_user_id: string;
}

export interface LotCreateInput {
  lot_number: string;
  supplier_id?: string | null;
  manufacture_date?: string | null;
  expiration_date?: string | null;
  status?: LotStatus;
  notes?: string | null;
}

/**
 * Body for ``PATCH /v1/lots/{id}``. ``lot_number`` and the parent item
 * are immutable identity, so they're absent. Editing a lot after entry
 * is a GxP-significant correction, so ``evidence_id`` (a fresh reauth
 * ticket minted for the ``lot.update`` action — see
 * {@link PasswordReauthDialog}) is always required. The ``reason`` (the
 * e-signature comment) is optional and recorded on the audit row when
 * provided.
 *
 * The editable fields are all optional — only send the ones that change.
 */
export interface LotUpdateInput {
  supplier_id?: string | null;
  manufacture_date?: string | null;
  expiration_date?: string | null;
  status?: LotStatus;
  notes?: string | null;
  /** Price paid for this lot. */
  unit_price_amount?: number | null;
  /** Received quantity for this lot (whole units). Editable as a correction,
   *  but the backend rejects (code ``qty_below_placed``) any value below what
   *  is already physically placed in locations — unplace first. */
  ordered_qty?: number | null;
  evidence_id: string;
  reason?: string;
}

export const lotsApi = {
  list: (opts?: {
    itemId?: string;
    status?: LotStatus;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }) =>
    api.get<Lot[]>('/lots', {
      query: {
        item_id: opts?.itemId,
        status: opts?.status,
        limit: opts?.limit,
        offset: opts?.offset,
      },
      signal: opts?.signal,
    }),

  get: (lotId: string, opts?: { signal?: AbortSignal }) =>
    api.get<Lot>(`/lots/${lotId}`, { signal: opts?.signal }),

  /** Is an operator-typed lot number still free? Advisory pre-check for the
   *  kitting close-out — the produce / close-out call re-checks and remains the
   *  authority (422 ``output_lot_number_taken``). */
  numberAvailable: (lotNumber: string, opts?: { signal?: AbortSignal }) =>
    api.get<{ lot_number: string; available: boolean }>('/lots/number-available', {
      query: { lot_number: lotNumber },
      signal: opts?.signal,
    }),

  listForItem: (itemId: string, opts?: { status?: LotStatus; signal?: AbortSignal }) =>
    api.get<Lot[]>(`/items/${itemId}/lots`, {
      query: { status: opts?.status },
      signal: opts?.signal,
    }),

  create: (itemId: string, input: LotCreateInput) =>
    api.post<Lot>(`/items/${itemId}/lots`, { json: input }),

  /**
   * E-signed lot edit. ``input`` must carry a fresh ``evidence_id``
   * (action='lot.update') and a ``reason``; the backend consumes the
   * evidence and links it to the audit row.
   */
  update: (lotId: string, input: LotUpdateInput) =>
    api.patch<Lot>(`/lots/${lotId}`, { json: input }),

  /**
   * Move a batch between release states (REQ-2026-07-31-STS-002).
   *
   * Its OWN endpoint and its own signing verb (`lot.release_state`) rather than
   * a field on {@link update}: a ticket minted to correct an expiry date must
   * not be spendable on releasing a batch. Admin / super-admin only.
   */
  setReleaseState: (
    lotId: string,
    input: { release_state: LotReleaseState; evidence_id: string; reason?: string | null },
  ) => api.post<Lot>(`/lots/${lotId}/release-state`, { json: input }),
};
