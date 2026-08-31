/**
 * Movements API — read-only view of the GxP ledger (``/api/v1/movements``
 * and the per-item ``/items/{id}/ledger``).
 *
 * Quantity movements (unit-IN / transfer / unit-OUT) are written by the
 * Location System (``location-nodes.ts``: place / transfer / consume); this
 * client only reads the resulting ledger rows for the audit / ledger views.
 *
 * Numeric fields are JSON strings (Postgres NUMERIC); the per-row adapter
 * (``movements-adapter.ts``) turns them into numbers before the table renders.
 */

import { api } from './client';
import type { LotReleaseState } from './lots';

export type MovementType =
  | 'receipt'
  | 'dispense'
  | 'adjustment'
  | 'discard'
  | 'transfer_out'
  | 'transfer_in'
  // Kitting / back-flush — written by the kitting module and present in the
  // ledger, so the item ledger must be able to label them.
  | 'kit_issue'
  | 'kit_additional_issue'
  | 'production_output'
  // Three distinct return events (kitting05). Every `Record<MovementType, …>`
  // must cover them — leaving them out of this union is what let an incomplete
  // icon map compile and then crash the audit timeline at runtime.
  | 'backflush'
  | 'kit_return'
  | 'kit_cancel_return'
  // Terminal customer shipment (CUST-001 / TRX-005) — the finished good leaves
  // inventory to a customer. Unit-out.
  | 'customer_shipment'
  // Consumable issued to a Kanban (TRX-003, consum01). Unit-out of the shelf,
  // into the room; terminal for quantity and never back-flushed.
  | 'consumable_issue'
  // Debit-and-gone issue to a scrap location (TRX-001/002, issue01) — PD, R&D,
  // a QC lab. Unit-out of the shelf INTO that location; the material leaves
  // controlled inventory and nothing is stored at the destination. The `to`
  // node on these rows is the disposition, not a balance.
  | 'material_issue';

/** Display labels — keep aligned with the backend ``MovementType`` enum. */
export const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  receipt: 'Unit in',
  dispense: 'Unit out',
  adjustment: 'Adjustment',
  discard: 'Discard',
  transfer_out: 'Transfer out',
  transfer_in: 'Transfer in',
  kit_issue: 'Kit issue',
  kit_additional_issue: 'Additional issue',
  production_output: 'Production output',
  // Three distinct return events (kitting05).
  backflush: 'Back-flushed',
  kit_return: 'Returned',
  kit_cancel_return: 'Cancel return',
  customer_shipment: 'Shipped to customer',
  consumable_issue: 'Issued to Kanban',
  // Named for where it went, like the two above it — "Issued" alone would read
  // as the Kanban issue, and the two are different transactions.
  material_issue: 'Issued to location',
};

/** Sign of the qty_delta enforced by each type — useful for colouring the row. */
export const MOVEMENT_TYPE_SIGN: Record<MovementType, 'in' | 'out' | 'signed'> = {
  receipt: 'in',
  transfer_in: 'in',
  dispense: 'out',
  discard: 'out',
  transfer_out: 'out',
  adjustment: 'signed',
  // Issues leave the source; output / back-flush land in a node.
  kit_issue: 'out',
  kit_additional_issue: 'out',
  production_output: 'in',
  // All three return events bring stock back into a node.
  backflush: 'in',
  kit_return: 'in',
  kit_cancel_return: 'in',
  customer_shipment: 'out',
  // Leaves the shelf for good — terminal for quantity (07-09 TRX-001).
  consumable_issue: 'out',
  // Leaves controlled inventory entirely (TRX-001/002), despite carrying a
  // destination node — that node records where it went, not where it now is.
  material_issue: 'out',
};

export interface ApiMovement {
  id: string;
  item_id: string;
  item_number: string | null;
  item_description: string | null;

  lot_id: string | null;
  lot_number: string | null;
  /** Lot expiry (ISO date) — surfaced in the ledger's Expiry column. */
  lot_expiration_date: string | null;
  /** The lot's release state AS IT IS NOW — not the state when this movement
   *  happened, which nothing records. Rendered on the ledger's per-lot subtotal
   *  row only, never on a movement row, or it would misread history. */
  lot_release_state: LotReleaseState | null;
  /** Decimal (string). The lot's per-unit price as it is NOW (RPT-003) — the
   *  same present-state caveat as `lot_release_state`. `null` is "no price
   *  recorded", never zero. */
  lot_unit_price_amount: string | null;

  /** Location System node references + resolved name / breadcrumb path. */
  from_location_node_id: string | null;
  from_location_node_name: string | null;
  from_location_node_path: string | null;
  to_location_node_id: string | null;
  to_location_node_name: string | null;
  to_location_node_path: string | null;

  movement_type: MovementType;
  /** Signed integer — ``+50`` / ``-3``. */
  qty_delta: number;
  /** Unsigned integer — what the operator entered. */
  qty_abs: number;

  /** Kit that caused this row (kit_issue / kit_additional_issue /
   *  production_output / backflush); null for every other movement. */
  kit_id: string | null;
  kit_number: string | null;
  /** Where the kit was BUILT. Not a movement end — a `production_output` mints a
   *  new lot, so `from_location_node_id` is null by constraint. */
  kit_production_location_node_id: string | null;
  kit_production_location_name: string | null;

  /** Customer shipment (CUST-001 / TRX-005): the named customer the finished
   *  good left inventory to (null = catalog / unassigned, TRX-007) and the
   *  reference / tracking number. Set only on ``customer_shipment`` rows. */
  customer_id: string | null;
  customer_name: string | null;
  reference_number: string | null;

  /** Mandatory §3 comment. */
  notes: string | null;

  /** FK into ``audit.reauth_events`` — the signing event behind this
   *  movement (who re-authenticated, when, and the attested meaning).
   *  The audit viewer links to it; there is no image to fetch. */
  reauth_evidence_id: string | null;

  performed_by_user_id: string;
  performed_by_user_name: string | null;
  performed_by_user_email: string | null;
  performed_at: string;
  created_at: string;
}

export interface ApiMovementListResponse {
  items: ApiMovement[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListMovementsParams {
  itemId?: string;
  lotId?: string;
  /** Filter to movements touching a storage node (from OR to). */
  locationNodeId?: string;
  type?: MovementType;
  limit?: number;
  offset?: number;
}

export const movementsApi = {
  list: (params: ListMovementsParams = {}, opts?: { signal?: AbortSignal }) =>
    api.get<ApiMovementListResponse>('/movements', {
      query: {
        item_id: params.itemId,
        lot_id: params.lotId,
        location_node_id: params.locationNodeId,
        type: params.type,
        limit: params.limit,
        offset: params.offset,
      },
      signal: opts?.signal,
    }),

  /** One ledger entry by id — backs the audit viewer's movement detail sheet,
   *  which now opens from a paged timeline row rather than from a cached copy
   *  of the whole ledger. */
  get: (movementId: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiMovement>(`/movements/${movementId}`, { signal: opts?.signal }),

  /**
   * Per-item ledger. The backend 404s when the item doesn't exist
   * (instead of returning an empty list), so callers can distinguish
   * "no movements yet" from "wrong item ID."
   */
  listForItem: (
    itemId: string,
    params: { limit?: number; offset?: number } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<ApiMovementListResponse>(`/items/${itemId}/ledger`, {
      query: { limit: params.limit, offset: params.offset },
      signal: opts?.signal,
    }),
};
