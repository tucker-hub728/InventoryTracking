/**
 * Items API — wraps ``/v1/items`` (via the BFF proxy).
 *
 * Week-1 raw-materials scope: every item is tier ``CR``. Numeric fields
 * (``on_hand``, ``quantity_available``) come back as strings when the
 * backend serialises Postgres NUMERIC — use {@link toNum} to consume them.
 */

import { api } from './client';

export type ItemTier = 'CR' | 'AY' | 'FG';

export interface ApiItem {
  id: string;
  item_code: string;
  item_name: string;
  description: string | null;
  tier: ItemTier;
  is_consumable: boolean;
  unit_of_measure: string;
  default_location_id: string | null;
  track_expiry: boolean;
  is_active: boolean;
  /** Total on-hand across all locations/lots (NUMERIC → string). */
  on_hand: string | number;
  /** Distinct locations this item has stock in. */
  location_count: number;
  created_at: string;
  updated_at: string;
}

export interface ApiItemStockRow {
  location_id: string;
  location_name: string | null;
  lot_number: string | null;
  expiry_date: string | null;
  quantity_available: string | number;
  unit_of_measure: string;
}

/** Detail response = list row + per-location stock breakdown. */
export interface ApiItemDetail extends ApiItem {
  stock: ApiItemStockRow[];
}

/** One transaction as it touched this item — the Recent-transactions row. */
export interface ApiItemLedgerEntry {
  transaction_id: string;
  transaction_no: string;
  transaction_type: string;
  transaction_date: string;
  created_by_name: string | null;
  quantity: string | number;
  unit_of_measure: string;
  from_location_name: string | null;
  to_location_name: string | null;
  lot_numbers: string[];
  reference_no: string | null;
  notes: string | null;
}

export interface ListItemsParams {
  tier?: ItemTier;
  active?: boolean;
  search?: string | null;
}

export interface ItemCreateInput {
  item_code: string;
  item_name: string;
  description?: string | null;
  tier: ItemTier;
  is_consumable: boolean;
  unit_of_measure: string;
  default_location_id?: string | null;
  track_expiry: boolean;
}

export interface ItemUpdateInput {
  item_name?: string;
  description?: string | null;
  is_consumable?: boolean;
  unit_of_measure?: string;
  default_location_id?: string | null;
  track_expiry?: boolean;
  is_active?: boolean;
}

export const itemsApi = {
  list: (params: ListItemsParams = {}, opts?: { signal?: AbortSignal }) =>
    api.get<ApiItem[]>('/items', {
      query: {
        tier: params.tier,
        active: params.active,
        search: params.search ?? undefined,
      },
      signal: opts?.signal,
    }),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiItemDetail>(`/items/${id}`, { signal: opts?.signal }),

  /** Item-scoped transaction ledger (newest first). */
  transactions: (id: string, params?: { limit?: number }, opts?: { signal?: AbortSignal }) =>
    api.get<ApiItemLedgerEntry[]>(`/items/${id}/transactions`, {
      query: { limit: params?.limit },
      signal: opts?.signal,
    }),

  create: (input: ItemCreateInput) => api.post<ApiItem>('/items', { json: input }),

  update: (id: string, input: ItemUpdateInput) =>
    api.patch<ApiItem>(`/items/${id}`, { json: input }),

  /** Soft delete — the backend flips ``is_active`` to false (204). */
  remove: (id: string) => api.delete<void>(`/items/${id}`),
};
