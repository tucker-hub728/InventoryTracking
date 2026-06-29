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
  vendor_id: string;
  vendor_name: string | null;
  ordered_qty: number;
  /** Decimal serialised as a string (or null). */
  unit_price_amount: string | null;
  /** Derived — Σ received across all events. */
  received_qty: number;
  /** Derived — max(0, ordered − received). */
  outstanding_qty: number;
}

export interface ReceiptEventLine {
  id: string;
  line_id: string;
  qty_received: number;
  over_receipt_reason: string | null;
  lot_id: string;
  lot_number: string | null;
}

export interface ReceiptEvent {
  id: string;
  received_at: string; // date (YYYY-MM-DD)
  received_by_user_id: string;
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

// ── Write models ─────────────────────────────────────────────────────────

export interface OrderLineInput {
  item_id: string;
  /** Must be one of the item's assigned vendors (``meta.item_vendors``). */
  vendor_id: string;
  ordered_qty: number;
  unit_price?: number | null;
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

export interface ReceiveEventLineInput {
  line_id: string;
  qty_received: number;
  lot_number: string;
  manufacture_date?: string | null;
  expiration_date?: string | null;
  unit_price_amount?: number | null;
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
    status?: OrderStatus;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }) =>
    api.get<OrderListResponse>('/receiving/transactions', {
      query: {
        status: opts?.status,
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
};
