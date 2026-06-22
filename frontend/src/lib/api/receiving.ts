/**
 * Receipt Admin API — wraps ``/api/v1/receiving`` (Requirements v2).
 *
 * Two-step inbound flow:
 *   1. ``createIntake`` — places an order: creates ON_ORDER lots under a
 *      receipt-transaction header. No stock moves yet, so it is NOT
 *      e-signed.
 *   2. ``receive`` — physical receipt: flips lots to AVAILABLE, posts the
 *      ledger movement(s), and supports splitting one ON_ORDER lot into
 *      multiple supplier lots. E-signed (action ``receipt.confirm``).
 *
 * See docs/modules/receipt-admin.md.
 */

import { api } from './client';
import type { Lot } from './lots';

export type ReceiptTransactionStatus = 'open' | 'received' | 'cancelled';

export const RECEIPT_STATUS_LABEL: Record<ReceiptTransactionStatus, string> = {
  open: 'On order',
  received: 'Received',
  cancelled: 'Cancelled',
};

export interface ReceiptTransaction {
  id: string;
  item_id: string;
  item_number: string | null;
  item_description: string | null;
  status: ReceiptTransactionStatus;
  po_reference: string | null;
  notes: string | null;
  created_by_user_id: string;
  received_by_user_id: string | null;
  received_at: string | null;
  created_at: string;
  updated_at: string;
  lots: Lot[];
}

export interface ReceiptTransactionListResponse {
  items: ReceiptTransaction[];
  total: number;
  limit: number;
  offset: number;
}

// ── Intake (step 1–4) ───────────────────────────────────────────────────

export interface ReceiptIntakeLotInput {
  lot_number: string;
  quantity: number;
  /**
   * Vendor is mandatory — exactly one of id / name. Whichever vendor is
   * used is automatically attached to the item's vendor list (the item's
   * vendors ARE its approved vendors); there is no separate approval step.
   */
  vendor_id?: string | null;
  vendor_name?: string | null;
  unit_price?: number | null;
  po_reference?: string | null;
  manufacture_date?: string | null;
  expiration_date?: string | null;
  notes?: string | null;
}

export interface ReceiptIntakeInput {
  item_id: string;
  po_reference?: string | null;
  notes?: string | null;
  lots: ReceiptIntakeLotInput[];
}

// ── Receive (step 5) ─────────────────────────────────────────────────────

export interface ReceiveSplitInput {
  /** Optional vendor override; defaults to the on-order lot's vendor. */
  vendor_id?: string | null;
  vendor_name?: string | null;
  unit_price?: number | null;
  po_reference?: string | null;
  /** Set on splits after the first to create a child supplier lot. */
  lot_number?: string | null;
  manufacture_date?: string | null;
  expiration_date?: string | null;
  notes?: string | null;
}

export interface ReceiveLineInput {
  lot_id: string;
  splits: ReceiveSplitInput[];
}

export interface ReceiveInput {
  /**
   * Receive captures no quantity and no placement — it only flips the lot to
   * available (+ optional split into supplier lots). Quantity arrives later as
   * a unit-IN (place) in the Location System.
   */
  lines: ReceiveLineInput[];
  /** Fresh reauth evidence id (action ``receipt.confirm``). */
  evidence_id: string;
}

export const receivingApi = {
  listTransactions: (opts?: {
    itemId?: string;
    status?: ReceiptTransactionStatus;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }) =>
    api.get<ReceiptTransactionListResponse>('/receiving/transactions', {
      query: {
        item_id: opts?.itemId,
        status: opts?.status,
        limit: opts?.limit,
        offset: opts?.offset,
      },
      signal: opts?.signal,
    }),

  getTransaction: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ReceiptTransaction>(`/receiving/transactions/${id}`, {
      signal: opts?.signal,
    }),

  createIntake: (input: ReceiptIntakeInput) =>
    api.post<ReceiptTransaction>('/receiving/transactions', { json: input }),

  /** E-signed physical receipt. ``input.evidence_id`` is consumed once. */
  receive: (id: string, input: ReceiveInput) =>
    api.post<ReceiptTransaction>(`/receiving/transactions/${id}/receive`, {
      json: input,
    }),
};
