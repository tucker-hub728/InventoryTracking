/**
 * Locations API — wraps ``/api/v1/locations``.
 *
 * Same admin-CRUD shape as vendors. PATCH / DELETE write through the
 * audit module (Chunk A); soft delete only — ``is_active=false`` so
 * historic movements keep resolving the location name.
 */

import { api } from './client';

export type LocationKind =
  | 'LN2'
  | 'minus_80'
  | 'minus_20'
  | 'fridge'
  | 'room_temp'
  | 'cold_room'
  | 'incubator'
  | 'other';

/** Display labels — keep aligned with the backend ``LocationKind`` enum. */
export const LOCATION_KIND_OPTIONS: { code: LocationKind; label: string }[] = [
  { code: 'LN2', label: 'LN2 (vapor-phase, ~ -196 °C)' },
  { code: 'minus_80', label: '-80 °C freezer' },
  { code: 'minus_20', label: '-20 °C freezer' },
  { code: 'fridge', label: 'Refrigerator (2–8 °C)' },
  { code: 'cold_room', label: 'Cold room (walk-in)' },
  { code: 'room_temp', label: 'Room temperature' },
  { code: 'incubator', label: 'Incubator' },
  { code: 'other', label: 'Other' },
];

export const LOCATION_KIND_LABEL: Record<LocationKind, string> =
  Object.fromEntries(
    LOCATION_KIND_OPTIONS.map((o) => [o.code, o.label]),
  ) as Record<LocationKind, string>;

export interface Location {
  id: string;
  code: string;
  name: string;
  kind: LocationKind;
  /** Postgres NUMERIC → JSON string. */
  temperature_c: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface LocationCreateInput {
  code: string;
  name: string;
  kind: LocationKind;
  temperature_c?: number | null;
  notes?: string | null;
  is_active?: boolean;
}

export interface LocationUpdateInput {
  code?: string;
  name?: string;
  kind?: LocationKind;
  temperature_c?: number | null;
  notes?: string | null;
  is_active?: boolean;
}

export const locationsApi = {
  list: (opts?: {
    activeOnly?: boolean;
    kind?: LocationKind;
    signal?: AbortSignal;
  }) =>
    api.get<Location[]>('/locations', {
      query: {
        active_only: opts?.activeOnly ?? true,
        kind: opts?.kind,
      },
      signal: opts?.signal,
    }),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<Location>(`/locations/${id}`, { signal: opts?.signal }),

  create: (input: LocationCreateInput) =>
    api.post<Location>('/locations', { json: input }),

  update: (id: string, input: LocationUpdateInput) =>
    api.patch<Location>(`/locations/${id}`, { json: input }),

  /** Soft delete (``is_active=false``). Idempotent. */
  deactivate: (id: string) => api.delete<Location>(`/locations/${id}`),
};
