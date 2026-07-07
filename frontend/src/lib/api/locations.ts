/**
 * Locations API — wraps ``/v1/locations`` (via the BFF proxy).
 *
 * A location is a single self-referencing row: a top-level location
 * (``parent_location_id === null``) or a shelf sub-location under one.
 */

import { api } from './client';

export interface ApiLocation {
  id: string;
  location_name: string;
  location_type: string;
  parent_location_id: string | null;
  parent_name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** A shelf sub-location with its own (direct) stock rollup. */
export interface ApiShelfOverview {
  id: string;
  location_name: string;
  location_type: string;
  parent_location_id: string | null;
  is_active: boolean;
  on_hand: string | number;
  distinct_lots: number;
}

/** A top-level location: stock rolled up across itself + its shelves. */
export interface ApiLocationOverview {
  id: string;
  location_name: string;
  location_type: string;
  is_active: boolean;
  on_hand: string | number;
  distinct_lots: number;
  children: ApiShelfOverview[];
}

export interface ListLocationsParams {
  active?: boolean;
  parent_id?: string | null;
}

export interface LocationCreateInput {
  location_name: string;
  location_type: string;
  parent_location_id?: string | null;
  is_active?: boolean;
}

export interface LocationUpdateInput {
  location_name?: string;
  location_type?: string;
  parent_location_id?: string | null;
  is_active?: boolean;
}

export const locationsApi = {
  list: (params: ListLocationsParams = {}, opts?: { signal?: AbortSignal }) =>
    api.get<ApiLocation[]>('/locations', {
      query: {
        active: params.active,
        parent_id: params.parent_id ?? undefined,
      },
      signal: opts?.signal,
    }),

  /** By-category tree: top-level locations (rolled-up stock) + their shelves. */
  overview: (opts?: { signal?: AbortSignal }) =>
    api.get<ApiLocationOverview[]>('/locations/overview', { signal: opts?.signal }),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiLocation>(`/locations/${id}`, { signal: opts?.signal }),

  create: (input: LocationCreateInput) =>
    api.post<ApiLocation>('/locations', { json: input }),

  update: (id: string, input: LocationUpdateInput) =>
    api.patch<ApiLocation>(`/locations/${id}`, { json: input }),

  /** Hard delete — 409 if the location has shelves, stock, or history. */
  remove: (id: string) => api.delete<void>(`/locations/${id}`),
};
