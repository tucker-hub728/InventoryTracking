/**
 * Stock API — wraps ``/v1/stock`` (via the BFF proxy).
 *
 * A flat per-(item, location, lot) balance row.
 */

import { api } from './client';

export interface ApiStockRow {
  id: string;
  item_id: string;
  item_code: string | null;
  item_name: string | null;
  location_id: string;
  location_name: string | null;
  lot_number: string | null;
  expiry_date: string | null;
  quantity_available: string | number;
  unit_of_measure: string;
}

export interface ListStockParams {
  item_id?: string | null;
  location_id?: string | null;
}

export const stockApi = {
  list: (params: ListStockParams = {}, opts?: { signal?: AbortSignal }) =>
    api.get<ApiStockRow[]>('/stock', {
      query: {
        item_id: params.item_id ?? undefined,
        location_id: params.location_id ?? undefined,
      },
      signal: opts?.signal,
    }),
};
