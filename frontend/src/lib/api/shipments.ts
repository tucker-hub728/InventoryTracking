/**
 * Shipments API surface — wraps ``/api/v1/shipments``.
 *
 * The terminal ship-finished-good-out transaction (CUST-001 / TRX-005). A
 * shipment draws one or more lots across storage locations and posts a
 * ``customer_shipment`` ledger row per source. The customer is REQUIRED — every
 * shipment names one.
 *
 * The read half of this surface is the per-customer history behind
 * ``/customers/[id]``. It is read-only by design (CUST-003): there is no edit
 * and no delete, because a wrong shipment is corrected with a new ledger row.
 */

import { api } from './client';
import type { CellOption } from './kits';
import type { LotReleaseState } from './lots';

/** A shippable source row: a lot at a storage location with its available qty.
 *  For an LN2 box it also carries the grid geometry + occupied vials so the
 *  dialog can draw the box and the operator taps exact vials. */
export interface ShipSource {
  lot_id: string;
  lot_number: string | null;
  /** The lot's release state, or null where no release workflow applies. */
  release_state: LotReleaseState | null;
  expiration_date: string | null;
  node_id: string;
  /** Human location path, e.g. "Warehouse One › Shelf B". */
  location: string;
  qty: number;
  is_grid: boolean;
  grid_rows: number | null;
  grid_cols: number | null;
  /** This lot's occupied vials in the box (empty for bulk locations). */
  cells: CellOption[];
}

/** One source pick — a quantity of one lot at one storage node. LN2 box picks
 *  carry the exact vial allocation ids. */
export interface ShipSourceInput {
  node_id: string;
  lot_id: string;
  qty: number;
  cell_allocation_ids?: string[];
}

export interface ShipOutInput {
  /** One or more sources (lot × location) — supports shipping stock that is
   *  spread across several locations. */
  sources: ShipSourceInput[];
  /** Required — every shipment names a customer. */
  customer_id: string;
  reference_number?: string | null;
  evidence_id: string;
  notes?: string | null;
}

export interface ShipmentLine {
  lot_id: string;
  lot_number: string | null;
  qty: number;
}

export interface Shipment {
  item_id: string;
  item_number: string;
  total_qty: number;
  customer_id: string;
  customer_name: string;
  reference_number: string | null;
  performed_at: string;
  lines: ShipmentLine[];
}

export const shipmentsApi = {
  /** A finished good's shippable stock (lot × storage location). */
  sources: (itemId: string, opts?: { signal?: AbortSignal }) =>
    api.get<ShipSource[]>(`/shipments/sources/${itemId}`, { signal: opts?.signal }),

  /** Ship a quantity out to a customer (terminal, e-signed). */
  ship: (input: ShipOutInput) => api.post<Shipment>('/shipments', { json: input }),

  /** Lifetime shipped totals for EVERY customer, in one request — so the
   *  customers list can show the relationship without a call per row. */
  summaryByCustomer: (opts?: { signal?: AbortSignal }) =>
    api.get<CustomerShippedTotals[]>('/shipments/summary/by-customer', {
      signal: opts?.signal,
    }),

  /** What one customer has been sent, rolled up by item. Unpaged — a customer
   *  takes a handful of finished goods. */
  shippedItems: (customerId: string, opts?: { signal?: AbortSignal }) =>
    api.get<CustomerShippedItems>(`/shipments/by-customer/${customerId}/items`, {
      signal: opts?.signal,
    }),

  /** One customer's shipment history, newest first, one row per signed
   *  shipment (not per ledger row). Server-paged. */
  byCustomer: (
    customerId: string,
    params: { limit?: number; offset?: number } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<CustomerShipments>(`/shipments/by-customer/${customerId}`, {
      query: { limit: params.limit, offset: params.offset },
      signal: opts?.signal,
    }),
};

/* ── Per-customer shipment history (read-only — CUST-003) ───────────── */

/** One customer's lifetime figures, for the customers list. Customers never
 *  shipped to are ABSENT from the response, not zeroed — the list renders the
 *  dash from the gap. */
export interface CustomerShippedTotals {
  customer_id: string;
  /** Signed ship actions, not ledger rows: a multi-lot ship counts once. */
  shipment_count: number;
  total_qty: number;
  last_shipped_at: string | null;
}

/** One item this customer has been sent, with its lifetime total. */
export interface CustomerShippedItem {
  item_id: string;
  /** Empty only when the item was deleted out from under its ledger rows. */
  item_number: string;
  item_description: string | null;
  total_qty: number;
  shipment_count: number;
  last_shipped_at: string | null;
}

export interface CustomerShippedItems {
  items: CustomerShippedItem[];
  total_qty: number;
  shipment_count: number;
}

/** One lot a shipment drew from — one ledger row. */
export interface CustomerShipmentLine {
  movement_id: string;
  lot_id: string | null;
  lot_number: string | null;
  qty: number;
  /** Location path snapshot from when the row was written, not a live lookup. */
  source_path: string | null;
  /** The shelf itself, so the row links to it the way the ledger does. */
  source_node_id: string | null;
}

/** One shipment — one signed operator action, not one ledger row. A
 *  multi-source ship is folded back together, with its lots in `lines`. */
export interface CustomerShipmentEvent {
  shipped_at: string;
  item_id: string;
  item_number: string;
  item_description: string | null;
  total_qty: number;
  reference_number: string | null;
  shipped_by: string | null;
  notes: string | null;
  lines: CustomerShipmentLine[];
}

export interface CustomerShipments {
  items: CustomerShipmentEvent[];
  /** EVENTS, not ledger rows — matches the rows rendered. */
  total: number;
  total_qty: number;
  limit: number;
  offset: number;
}
