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

export interface Lot {
  id: string;
  item_id: string;
  lot_number: string;
  vendor_id: string | null;
  vendor_name: string | null;
  /** Convenience joined from items for the admin list. */
  item_number: string | null;
  item_description: string | null;
  manufacture_date: string | null;
  expiration_date: string | null;
  coa_url: string | null;
  status: LotStatus;
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
  /** Vendor not in the item's approved list (flag, not a status). */
  unverified_vendor_for_item: boolean;
  /** Vendor never previously associated with this item (flag, not a status). */
  vendor_not_previously_associated_with_item: boolean;
  /** Ordered qty captured at intake (planning data; NUMERIC → string). */
  ordered_qty: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string;
  updated_by_user_id: string;
}

export interface LotCreateInput {
  lot_number: string;
  vendor_id?: string | null;
  manufacture_date?: string | null;
  expiration_date?: string | null;
  coa_url?: string | null;
  status?: LotStatus;
  notes?: string | null;
}

/**
 * Body for ``PATCH /v1/lots/{id}``. ``lot_number`` and the parent item
 * are immutable identity, so they're absent. Editing a lot after entry
 * is a GxP-significant correction, so two fields are always required:
 *
 *   * ``evidence_id`` — a fresh reauth ticket minted for the
 *     ``lot.update`` action (see {@link PasswordReauthDialog}).
 *   * ``reason`` — the mandatory "reason for change" recorded on the
 *     audit row.
 *
 * The editable fields are all optional — only send the ones that change.
 */
export interface LotUpdateInput {
  vendor_id?: string | null;
  manufacture_date?: string | null;
  expiration_date?: string | null;
  coa_url?: string | null;
  status?: LotStatus;
  notes?: string | null;
  evidence_id: string;
  reason: string;
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
};
