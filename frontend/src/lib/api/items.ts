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

// ── Wire shape ─────────────────────────────────────────────────────────

export type ApiItemStatus = 'available' | 'low_stock' | 'out_of_stock';

/** One supplier assigned to an item (part of ``ApiItem.suppliers``). */
export interface ApiItemSupplier {
  supplier_id: string;
  supplier_name: string;
}

/** Raw API row — numeric fields come back as strings (Postgres NUMERIC). */
export type ApiCategoryKind = 'purchased' | 'built';

export interface ApiItem {
  id: string;
  item_number: string;
  description: string;
  /** Category (requirements v2 §6). ``category_kind`` drives the Type column:
   *  built → "Product" (may have a BOM), purchased → bought as-is. */
  category_id: string;
  category_name: string;
  category_kind: ApiCategoryKind;
  category_tone: string;
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
  /** Inventory $ — Σ(on-hand units × their lot's unit price). Lot-derived. */
  inv_value_amount: string;
  /** On-order $ — Σ(ordered qty × unit price) over ON_ORDER lots. Lot-derived. */
  po_value_amount: string;
  status_code: ApiItemStatus;
  last_movement_at: string | null;
  /** On-hand minus units in date-expired lots — the count used for
   *  reorder + forecasting. ``qty_on_hand`` stays as the physical total. */
  qty_available: string;
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
  /** Filter by item category (server-side). */
  category_id?: string | null;
  /** Filter by ``v_item_stock.status_code`` (server-side). */
  status?: ApiItemStatus | null;
  sort?: ApiSortField;
  direction?: ApiSortDirection;
  limit?: number;
  offset?: number;
}

export interface ItemCreateInput {
  item_number: string;
  description: string;
  /** Required — the item's category (governs BOM eligibility). */
  category_id: string;
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
  /** Re-categorise the item. Blocked server-side if moving a BOM-bearing
   *  item to a purchased category. */
  category_id?: string;
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
        category_id: params.category_id ?? undefined,
        status: params.status ?? undefined,
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
   * Fetch by the human-readable item number (e.g. ``CM-0001``) — this is
   * what the detail page URL uses, so URL-driven fetches skip the UUID
   * round-trip. ``itemNumber`` is free-form and URL-encoded before send;
   * the backend treats it as an opaque key and 404s on miss.
   */
  getByNumber: (itemNumber: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiItem>(`/items/by-number/${encodeURIComponent(itemNumber)}`, {
      signal: opts?.signal,
    }),

  create: (input: ItemCreateInput) =>
    api.post<ApiItem>('/items', { json: input }),

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
