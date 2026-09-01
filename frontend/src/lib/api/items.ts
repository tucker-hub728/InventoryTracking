/**
 * Items API surface — wraps ``/api/v1/items``.
 *
 * Two layers of types here:
 *
 * * ``ApiItem`` mirrors the backend response 1:1, including the numeric
 *   strings (Postgres NUMERIC → JSON string) and the snake_case keys.
 *   This is what the network actually returns; nothing else in the app
 *   should know about it.
 *
 * * ``InventoryItem`` (defined in ``@/types/inventory``) is the
 *   camelCase, numeric, UI-friendly shape that components consume.
 *
 * The adapter lives next to this client (``items-adapter.ts``) so the
 * boundary is clear: API → adapter → store → components.
 */

import { api } from './client';
import type { CellOption } from './kits';
import type { LotReleaseState } from './lots';

// ── Wire shape ─────────────────────────────────────────────────────────

export type ApiItemStatus = 'available' | 'low_stock' | 'out_of_stock';

/** One place an item is stocked: a lot at a storage location with its available
 *  quantity. For an LN2 box it also carries the grid geometry + this lot's
 *  occupied vials, so a picker can draw the box and the operator taps exact
 *  vials. Same shape as a shipment source, but served for every tier. */
export interface ApiItemStockLocation {
  lot_id: string;
  lot_number: string | null;
  /** The lot's release state, or null where no release workflow applies. */
  release_state: LotReleaseState | null;
  expiration_date: string | null;
  node_id: string;
  /** Human location path, e.g. "Warehouse One › Shelf B". */
  location: string;
  /** What kind of place this is. Carried so the transfer dialog can apply the
   *  LOC-003 cold-chain rule — an LN2 source may only be sent to another LN2
   *  box — without inferring it from ``is_grid``, which matches only by the
   *  coincidence that the Box is today the one grid-bearing node type. */
  node_type: string;
  qty: number;
  is_grid: boolean;
  grid_rows: number | null;
  grid_cols: number | null;
  cells: CellOption[];
}

/**
 * One lot that has arrived but has not been received to inventory (REQ-004).
 *
 * It exists, it is in the building, and it is deliberately NOT stock yet: no
 * allocation, no ledger movement, so it is absent from on-hand, from the Unit
 * Ledger, and from every transfer / kit / issue / ship picker — all of which
 * read allocations. This is the only surface that shows it.
 */
export interface ApiAwaitingPutAway {
  lot_id: string;
  lot_number: string;
  /** CONSUME units still to place — less than `received_units` when an earlier
   *  earlier partial receipt already shelved some of it. */
  remaining_units: number;
  received_units: number;
  expiration_date: string | null;
  manufacture_date: string | null;
  po_reference: string | null;
  received_at: string | null;
  supplier_name: string | null;
}

/** One supplier assigned to an item (part of ``ApiItem.suppliers``). */
export interface ApiItemSupplier {
  supplier_id: string;
  supplier_name: string;
}

import type { TierType } from './tiers';

export type { TierType };

/** Raw API row — numeric fields come back as strings (Postgres NUMERIC). */
export interface ApiItem {
  id: string;
  item_number: string;
  description: string;
  /** The CONSUME unit (each, mL …) — what stock is counted in. Null unset.
   *  The only unit an item has: the ORDER unit ("Box" and its size) lives on
   *  the Order line (REQ-001), because a pack describes a purchase rather
   *  than a material. See `OrderLineInput` in `receiving.ts`. */
  uom: string | null;
  /** Blind-consumed (no per-lot traceability) when true. */
  is_consumable: boolean;
  /** Consumed to the kit, never back-flushed (KIT-003) when true. */
  consumed_in_kit: boolean;
  /** Tier (REQ-2026-07-15-ITM-001). ``tier_type`` drives the Type column:
   *  sub_assembly / finished_good may have a BOM; raw_material is bought as-is. */
  tier_id: string;
  tier_name: string;
  tier_type: TierType;
  tier_tone: string;
  /** The item's type prefix (REQ-2026-07-09-ITM-001) — the tab/filter criterion.
   *  Lives inside the tier; ``prefix_code`` fronts the SKU on the create form. */
  prefix_id: string;
  prefix_code: string;
  prefix_label: string | null;
  /** The SKU tail only (e.g. '001'). The full ``item_number`` above is derived
   *  as ``<prefix_code>-<sku_suffix>`` and follows the prefix on rename. */
  sku_suffix: string;
  /** Assigned suppliers — the suppliers this item can be received against. */
  suppliers: ApiItemSupplier[];
  avg_lead_days: number | null;
  reorder_threshold: string;
  near_expiry_threshold_days: number;
  must_order_flag: boolean;
  last_updated_on: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  qty_on_hand: string;
  qty_on_order: string;
  /** Units arrived but not yet placed on a shelf (REQ-004). Neither available
   *  nor on-order: on site, but not pickable. */
  qty_awaiting_release: string;
  /** Inventory $ — Σ(on-hand units × their lot's unit price). Lot-derived. */
  inv_value_amount: string;
  /** On-order $ — Σ(ordered qty × unit price) over ON_ORDER lots. Lot-derived. */
  po_value_amount: string;
  status_code: ApiItemStatus;
  last_movement_at: string | null;
  /** On-hand minus units in date-expired lots — the count used for
   *  reorder + forecasting. ``qty_on_hand`` stays as the physical total. */
  qty_available: string;
  /** Direct BOM components. Always 0 for a raw material; on a built tier, 0
   *  means the recipe hasn't been defined yet. */
  bom_line_count: number;
}

export interface ApiItemListResponse {
  items: ApiItem[];
  total: number;
  limit: number;
  offset: number;
}

// ── Request shapes ─────────────────────────────────────────────────────

export type ApiSortField = 'item_number' | 'description' | 'updated_at' | 'created_at';
export type ApiSortDirection = 'asc' | 'desc';

export interface ListItemsParams {
  q?: string | null;
  supplier_id?: string | null;
  /** Filter by item tier (server-side). */
  tier_id?: string | null;
  /** Filter by item prefix (server-side). */
  prefix_id?: string | null;
  /** Filter by ``v_item_stock.status_code`` (server-side). */
  status?: ApiItemStatus | null;
  /** ``true`` = consumables only, ``false`` = non-consumables only. */
  is_consumable?: boolean | null;
  /** ``false`` selects items with no bill of materials ("missing BOM"). */
  has_bom?: boolean | null;
  /** Only items whose BOM has at least this many distinct components. */
  min_bom_lines?: number | null;
  /**
   * ``true`` selects items at or below their reorder threshold. Broader than
   * ``status: 'low_stock'``, which excludes zero-stock items (the view tests
   * ``qty_available <= 0`` first, so those read as ``out_of_stock``).
   */
  below_reorder?: boolean | null;
  /**
   * `true` selects items with stock that has ARRIVED but is not yet placed and
   * released (REQ-2026-07-31-STS-001) â material on site and paid for, which
   * the reorder screen deliberately does not count as missing.
   */
  awaiting_release?: boolean | null;
  sort?: ApiSortField;
  direction?: ApiSortDirection;
  limit?: number;
  offset?: number;
}

export interface ItemCreateInput {
  /** The SKU tail only (e.g. '001'). The full number is derived server-side as
   *  ``<prefix code>-<suffix>``. */
  sku_suffix: string;
  description: string;
  /** Required — the item's prefix. The tier is derived from it server-side
   *  (a prefix lives inside one tier) and governs BOM eligibility. */
  prefix_id: string;
  /** The CONSUME unit (each, mL …) — what stock is counted in. No order unit
   *  here (REQ-001): the pack is set per Order line. The server `extra:
   *  forbid`s, so sending one 422s rather than being silently dropped. */
  uom?: string | null;
  /** Blind-consumed with no per-lot traceability when true. */
  is_consumable?: boolean;
  /** The media twin: consumed to the kit and never back-flushed (KIT-003).
   *  Mutually exclusive with `is_consumable` — the server 422s on both. */
  consumed_in_kit?: boolean;
  /** Assigned suppliers (zero-or-more). The only suppliers the item can later
   *  be received against. */
  supplier_ids?: string[];
  avg_lead_days?: number | null;
  reorder_threshold?: number;
  near_expiry_threshold_days?: number;
}

/**
 * Partial item update. ``item_number`` is intentionally not editable —
 * it's the immutable human handle. ``supplier_ids``, when present, REPLACES
 * the whole assigned-supplier list (omit to leave unchanged; ``[]`` clears).
 */
export interface ItemUpdateInput {
  description?: string;
  uom?: string | null;
  is_consumable?: boolean;
  consumed_in_kit?: boolean;
  /** Re-assign the item to another prefix (its tier is derived). Blocked
   *  server-side if moving a BOM-bearing item to a raw-material prefix. */
  prefix_id?: string;
  supplier_ids?: string[];
  avg_lead_days?: number | null;
  reorder_threshold?: number;
  near_expiry_threshold_days?: number;
  must_order_flag?: boolean;
}

// ── Client ─────────────────────────────────────────────────────────────

export const itemsApi = {
  list: (params: ListItemsParams = {}, opts?: { signal?: AbortSignal }) =>
    api.get<ApiItemListResponse>('/items', {
      query: {
        q: params.q ?? undefined,
        supplier_id: params.supplier_id ?? undefined,
        tier_id: params.tier_id ?? undefined,
        prefix_id: params.prefix_id ?? undefined,
        status: params.status ?? undefined,
        is_consumable: params.is_consumable ?? undefined,
        awaiting_release: params.awaiting_release ?? undefined,
        has_bom: params.has_bom ?? undefined,
        min_bom_lines: params.min_bom_lines ?? undefined,
        below_reorder: params.below_reorder ?? undefined,
        sort: params.sort,
        direction: params.direction,
        limit: params.limit,
        offset: params.offset,
      },
      signal: opts?.signal,
    }),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiItem>(`/items/${id}`, { signal: opts?.signal }),

  /**
   * Where this item is stocked, a row per (lot × storage location), FIFO
   * ordered. Feeds the "Stock by location" tab and the transfer dialog's source
   * picker (INV-007 / TRX-001). WIP on a production floor is excluded — the
   * kit's Return step is how that comes back, not a transfer.
   */
  stockLocations: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiItemStockLocation[]>(`/items/${id}/stock-locations`, {
      signal: opts?.signal,
    }),

  /**
   * What has ARRIVED for this item but has not been received to inventory yet (REQ-004).
   *
   * Deliberately a second call rather than a field on `stockLocations`: that
   * one is allocation-derived and answers "where is this item", so material
   * with no allocation is invisible to it by construction. This answers the
   * different question — "what turned up that nobody has shelved" — which is
   * exactly the material the other endpoint cannot see.
   */
  awaitingPutAway: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiAwaitingPutAway[]>(`/items/${id}/awaiting-put-away`, {
      signal: opts?.signal,
    }),

  /**
   * Fetch by the human-readable item number (e.g. ``CM-0001``) — this is
   * what the detail page URL uses, so URL-driven fetches skip the UUID
   * round-trip. ``itemNumber`` is free-form and URL-encoded before send;
   * the backend treats it as an opaque key and 404s on miss.
   */
  getByNumber: (itemNumber: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiItem>(`/items/by-number/${encodeURIComponent(itemNumber)}`, {
      signal: opts?.signal,
    }),

  create: (input: ItemCreateInput) => api.post<ApiItem>('/items', { json: input }),

  /** Partial update; writes an audit row server-side. */
  update: (id: string, input: ItemUpdateInput) =>
    api.patch<ApiItem>(`/items/${id}`, { json: input }),

  /**
   * Soft-delete (``deleted_at`` stamp). Server rejects with 422
   * ``item_has_stock`` if the live balance is > 0 — operators must
   * zero the qty (dispense or discard the remainder) first.
   */
  remove: (id: string) => api.delete<ApiItem>(`/items/${id}`),

  // ── Assigned suppliers ─────────────────────────────────────────────────
  /** List an item's assigned suppliers (the only ones it can be received
   *  against). To change the list, PATCH the item with ``supplier_ids``. */
  listSuppliers: (itemId: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiItemSupplier[]>(`/items/${itemId}/suppliers`, {
      signal: opts?.signal,
    }),
};
