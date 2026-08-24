/**
 * Orders API (Receipt Admin v3) — wraps ``/api/v1/receiving``.
 *
 * An "Order" is the receipt-transaction header with one-or-more **item lines**
 * and zero-or-more dated **receive events**. Lots are created at receive (one
 * lot per line × event), never at intake. Partial / blanket receiving is
 * supported: an Order is drawn down by many dated events until every line is
 * fully received.
 *
 *   1. ``createOrder``  — place an Order (multi-item). NOT e-signed.
 *   2. ``updateOrder``  — edit an un-received Order. NOT e-signed.
 *   3. ``receive``      — one dated receive event (partial). E-signed
 *      (action ``receipt.confirm``).
 *   4. ``cancelOrder`` / ``deleteOrder`` — abandon / soft-remove un-received.
 *
 * See docs/modules/receipt-admin.md (v3).
 */

import { api } from './client';

export type OrderStatus =
  | 'open'
  | 'partially_received'
  | 'received'
  | 'cancelled';

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  open: 'Open',
  partially_received: 'Partially received',
  received: 'Received',
  cancelled: 'Cancelled',
};

// ── Read models ──────────────────────────────────────────────────────────

export interface OrderLine {
  id: string;
  line_no: number;
  item_id: string;
  item_number: string | null;
  item_description: string | null;
  supplier_id: string;
  supplier_name: string | null;
  /** In ORDER units — 3 means three boxes when `pack_uom` is set (REQ-001). */
  ordered_qty: number;
  /** Decimal serialised as a string (or null). Per ORDER unit. */
  unit_price_amount: string | null;
  /** Derived — Σ received across all events. In ORDER units. */
  received_qty: number;
  /** Derived — max(0, ordered − received). In ORDER units. */
  outstanding_qty: number;
  /** The order unit ("Box"), or null when ordered in the consume unit. */
  pack_uom: string | null;
  /** Consume units per order unit. Null with a `pack_uom` set means the pack
   *  size was left for the receiver to confirm. */
  units_per_pack: number | null;
  /** Server-computed CONSUME units — what would actually land in a location.
   *  Use these for anything describing physical stock; never multiply in the
   *  client, or the arithmetic exists in two languages. */
  ordered_units: number;
  outstanding_units: number;
}

export interface ReceiptEventLine {
  id: string;
  line_id: string;
  /** In ORDER units — "+148" means 148 Cases when the line has a `pack_uom`.
   *  Never show this alone; pair it with the unit, or with `units_received`. */
  qty_received: number;
  over_receipt_reason: string | null;
  lot_id: string;
  lot_number: string | null;
  /** CONSUME units this draw actually placed — 148 Cases of 25 is 3,700. Read
   *  from the lot, so it is what was stored at receipt even if the line's pack
   *  size was corrected later. Null only for a lot with no recorded quantity. */
  units_received: number | null;
  manufacture_date: string | null;
  expiration_date: string | null;
  /** Decimal string, per CONSUME unit (6dp) — the divided figure. */
  unit_price_amount: string | null;
  release_state: 'quarantine' | 'qc_hold' | 'released' | 'rejected' | null;
}

export interface ReceiptEvent {
  id: string;
  received_at: string; // date (YYYY-MM-DD)
  received_by_user_id: string;
  /** Receiver's full name, resolved server-side. Null only if the user row is
   *  missing; fall back to the id when absent. */
  received_by_user_name: string | null;
  notes: string | null;
  created_at: string;
  lines: ReceiptEventLine[];
}

export interface Order {
  id: string;
  po_reference: string;
  status: OrderStatus;
  is_blanket: boolean;
  valid_from: string | null;
  valid_to: string | null;
  notes: string | null;
  created_by_user_id: string;
  received_by_user_id: string | null;
  received_at: string | null;
  /** Set once the retention policy shelved this Order (DATA-001); null = active. */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  lines: OrderLine[];
  events: ReceiptEvent[];
  total_ordered_qty: number;
  total_received_qty: number;
}

export interface OrderListResponse {
  items: Order[];
  total: number;
  limit: number;
  offset: number;
}

/** The Order retention policy and what it would do (DATA-001). */
export interface ArchivePolicy {
  /** The SAVED age. Previewing another value never changes this. */
  archive_after_days: number;
  /** How many Orders would archive — at the saved age, or at a previewed one. */
  eligible_now: number;
  archived_total: number;
  /** When the daily sweep last ran; null means it never has. */
  last_swept_at: string | null;
}

export interface ArchiveSweepResult {
  archived: number;
  archive_after_days: number;
}

// ── Write models ─────────────────────────────────────────────────────────

export interface OrderLineInput {
  item_id: string;
  /** Must be one of the item's assigned suppliers (``meta.item_suppliers``). */
  supplier_id: string;
  /** In ORDER units — the number the buyer typed, e.g. 3 (boxes). */
  ordered_qty: number;
  /** Per ORDER unit — $95.00 per Box, matching the supplier's invoice. */
  unit_price?: number | null;
  /** Omit both and the line is ordered in the item's consume unit — there is
   *  no item-level pack to inherit (REQ-001). Send `pack_uom` alone to order
   *  in packs whose size is confirmed at receive. Sending `units_per_pack`
   *  without `pack_uom` is rejected. */
  pack_uom?: string | null;
  units_per_pack?: number | null;
}

export interface OrderCreateInput {
  po_reference: string;
  is_blanket?: boolean;
  valid_from?: string | null;
  valid_to?: string | null;
  notes?: string | null;
  lines: OrderLineInput[];
}

export interface OrderUpdateInput {
  po_reference?: string;
  is_blanket?: boolean;
  valid_from?: string | null;
  valid_to?: string | null;
  notes?: string | null;
  /** When provided, replaces the whole line set (un-received Orders only). */
  lines?: OrderLineInput[];
}

export interface ReceivePlacementCell {
  grid_row: number;
  grid_col: number;
}

/** Where a received lot is placed (unit-in), sent with the receive. Single
 *  destination, exactly `qty_received × units_per_pack` CONSUME units — NOT
 *  `qty_received` itself (REQ-001). Receiving 3 Box of 100 places 300 units, so
 *  a box takes 300 distinct cells; a freezer sub-location / warehouse shelf
 *  takes all 300 (cells empty). */
export interface ReceivePlacementInput {
  node_id: string;
  cells: ReceivePlacementCell[];
}

export interface ReceiveEventLineInput {
  line_id: string;
  /** In ORDER units — the receiver confirms "3 boxes arrived". The server
   *  multiplies this to consume units for the lot and the placement. */
  qty_received: number;
  /** Always optional (REQ-003) — omit or send blank and the server
   *  synthesizes an `AUTO-…` number. A value that itself starts with `AUTO-`
   *  is refused, so the generated prefix stays meaningful. */
  lot_number?: string | null;
  manufacture_date?: string | null;
  expiration_date?: string | null;
  /** Per ORDER unit, like the order line's. */
  unit_price_amount?: number | null;
  /** The pack, settable or correctable here (REQ-001). Omit both to keep
   *  whatever the Order line carries; send them to put a pack on a line that
   *  has none, or to fix a wrong one — the receiver is the first person who can
   *  see what a box actually holds. Whatever is sent is written back to the
   *  line. A unit with no size, or a size with no unit, is a 422. */
  pack_uom?: string | null;
  units_per_pack?: number | null;
  placement: ReceivePlacementInput;
}

export interface ReceiveEventInput {
  received_at: string; // date
  lines: ReceiveEventLineInput[];
  notes?: string | null;
  /** Fresh reauth evidence id (action ``receipt.confirm``). */
  evidence_id: string;
}

export const receivingApi = {
  listOrders: (opts?: {
    /** Searches PO reference, item number / description, and lot number —
     *  server-side, so it sees every Order rather than the fetched page. */
    q?: string;
    /** Repeatable — the list filter is a SET of ticked statuses, and the
     *  working default is open + partially received (DATA-003). Omit for
     *  "any status". */
    status?: OrderStatus[];
    /** The retention archive (DATA-001). Not a status: an archived order still
     *  has one, which is why it is a separate axis and not a filter option. */
    bucket?: 'archived';
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }) =>
    api.get<OrderListResponse>('/receiving/transactions', {
      query: {
        q: opts?.q,
        status: opts?.status,
        bucket: opts?.bucket,
        limit: opts?.limit,
        offset: opts?.offset,
      },
      signal: opts?.signal,
    }),

  getOrder: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<Order>(`/receiving/transactions/${id}`, { signal: opts?.signal }),

  createOrder: (input: OrderCreateInput) =>
    api.post<Order>('/receiving/transactions', { json: input }),

  updateOrder: (id: string, input: OrderUpdateInput) =>
    api.patch<Order>(`/receiving/transactions/${id}`, { json: input }),

  /** E-signed soft-delete. ``evidenceId`` (action ``order.delete``) consumed once. */
  deleteOrder: (id: string, evidenceId: string) =>
    api.post<void>(`/receiving/transactions/${id}/delete`, {
      json: { evidence_id: evidenceId },
    }),

  /** E-signed cancel. ``evidenceId`` (action ``order.cancel``) consumed once. */
  cancelOrder: (id: string, evidenceId: string) =>
    api.post<Order>(`/receiving/transactions/${id}/cancel`, {
      json: { evidence_id: evidenceId },
    }),

  /** E-signed dated receive event. ``input.evidence_id`` is consumed once. */
  receive: (id: string, input: ReceiveEventInput) =>
    api.post<Order>(`/receiving/transactions/${id}/receive`, { json: input }),

  // ── Archiving (REQ-2026-07-15-DATA-001/002/003) ────────────────────────

  /** The retention policy. Pass ``days`` to preview a different age WITHOUT
   *  saving it — ``eligible_now`` then answers "how many would archive if I
   *  saved this", which is what the operator wants to know while typing. */
  getArchivePolicy: (opts?: { days?: number; signal?: AbortSignal }) =>
    api.get<ArchivePolicy>('/receiving/archive/policy', {
      query: { days: opts?.days },
      signal: opts?.signal,
    }),

  /** Super-admin only. */
  updateArchivePolicy: (archiveAfterDays: number) =>
    api.put<ArchivePolicy>('/receiving/archive/policy', {
      json: { archive_after_days: archiveAfterDays },
    }),

  /** Run the daily sweep now. Super-admin only. */
  runArchiveSweep: () =>
    api.post<ArchiveSweepResult>('/receiving/archive/sweep', { json: {} }),

  /** Put an archived Order back on the working list. Audited, not e-signed —
   *  nothing about the Order changes, only its visibility. */
  restoreOrder: (id: string) =>
    api.post<Order>(`/receiving/transactions/${id}/restore`, { json: {} }),
};
