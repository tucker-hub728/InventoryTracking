/**
 * Shipments API surface — wraps ``/api/v1/shipments``.
 *
 * The terminal ship-finished-good-out transaction (CUST-001 / TRX-005). A
 * shipment draws one lot at one storage location and posts a
 * ``customer_shipment`` ledger row. The customer is OPTIONAL — omit it for a
 * catalog / unassigned recipient (TRX-007).
 */

import { api } from './client';
import type { CellOption } from './kits';

/** A shippable source row: a lot at a storage location with its available qty.
 *  For an LN2 box it also carries the grid geometry + occupied vials so the
 *  dialog can draw the box and the operator taps exact vials. */
export interface ShipSource {
  lot_id: string;
  lot_number: string | null;
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
};
