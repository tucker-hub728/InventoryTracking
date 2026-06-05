/**
 * Items API surface — wraps ``/api/v1/items`` (and ``/items/next-number``).
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

// Free-form since Week 2: the item-number prefix is any 2–8 character,
// letter-led code (the backend CHECK enforces the shape). Kept as a named
// alias so call sites read clearly.
export type ApiItemPrefix = string;

export type ApiItemStatus = 'available' | 'low_stock' | 'out_of_stock';

/** Raw API row — numeric fields come back as strings (Postgres NUMERIC). */
export interface ApiItem {
  id: string;
  item_number: string;
  item_prefix: string;
  description: string;
  vendor_id: string | null;
  vendor_name: string | null;
  avg_lead_days: number | null;
  reorder_threshold: string;
  unit_price_amount: string | null;
  units_per_package: number | null;
  price_per_package_amount: string | null;
  uom_code: string;
  po_note: string | null;
  po_due_text: string | null;
  must_order_flag: boolean;
  last_updated_on: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  qty_on_hand: string;
  qty_on_order: string;
  inv_value_amount: string;
  po_value_amount: string;
  status_code: ApiItemStatus;
  last_movement_at: string | null;
}

export interface ApiItemListResponse {
  items: ApiItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApiNextNumberResponse {
  prefix: ApiItemPrefix;
  item_number: string;
}

// ── Request shapes ─────────────────────────────────────────────────────

export type ApiSortField = 'item_number' | 'description' | 'updated_at' | 'created_at';
export type ApiSortDirection = 'asc' | 'desc';

export interface ListItemsParams {
  q?: string | null;
  prefix?: ApiItemPrefix | null;
  vendor_id?: string | null;
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
  vendor_id?: string | null;
  avg_lead_days?: number | null;
  reorder_threshold?: number;
  unit_price_amount?: number | null;
  units_per_package?: number | null;
  uom_code?: string;
  po_note?: string | null;
  notes?: string | null;
}

/**
 * Partial item update. ``item_number`` is intentionally not editable
 * — it's the immutable human handle. ``uom_code`` can only change
 * while no movements exist (server returns 422 ``uom_change_after_movement``).
 */
export interface ItemUpdateInput {
  description?: string;
  vendor_id?: string | null;
  avg_lead_days?: number | null;
  reorder_threshold?: number;
  unit_price_amount?: number | null;
  units_per_package?: number | null;
  uom_code?: string;
  po_note?: string | null;
  notes?: string | null;
  must_order_flag?: boolean;
}

// ── Client ─────────────────────────────────────────────────────────────

export const itemsApi = {
  list: (params: ListItemsParams = {}, opts?: { signal?: AbortSignal }) =>
    api.get<ApiItemListResponse>('/items', {
      query: {
        q: params.q ?? undefined,
        prefix: params.prefix ?? undefined,
        vendor_id: params.vendor_id ?? undefined,
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
   * round-trip. ``itemNumber`` is sent as-is; the backend enforces the
   * ``^(CM|NM|CR|AY)-\d+$`` shape and 404s on miss.
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

  nextNumber: (prefix: ApiItemPrefix, opts?: { signal?: AbortSignal }) =>
    api.get<ApiNextNumberResponse>('/items/next-number', {
      query: { prefix },
      signal: opts?.signal,
    }),
};
