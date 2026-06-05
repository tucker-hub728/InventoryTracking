/**
 * Storage API — wraps ``/api/v1/storage`` (the LN2 / Storage grid).
 *
 * Location → Rack(rows×cols) → Position. Reads hydrate each position with
 * its occupant (lot → item) so the grid + position sheet render in one
 * round-trip. See ``docs/modules/storage.md``.
 */

import { api } from './client';
import type { LocationKind } from './locations';

/** Binary slot status as the backend stores it (lower-cased). */
export type PositionStatus = 'empty' | 'occupied';

export interface PositionRead {
  id: string;
  /** Row-major 1-based slot number within the rack. */
  index: number;
  row_idx: number;
  col_idx: number;
  /** Human grid label, e.g. ``C2``. */
  label: string;
  status: PositionStatus;
  lot_id: string | null;
  lot_number: string | null;
  /** Human item number (e.g. ``CM-0001``) — what ``/inventory/{id}`` keys on. */
  item_id: string | null;
  item_uuid: string | null;
  item_description: string | null;
  vendor_name: string | null;
  assigned_at: string | null;
}

export interface RackRead {
  id: string;
  name: string;
  rows: number;
  cols: number;
  position_order: number;
  positions: PositionRead[];
}

export interface StorageLocationRead {
  id: string;
  name: string;
  kind: LocationKind;
  detail: string;
  racks: RackRead[];
}

export interface RackInput {
  name: string;
  rows: number;
  cols: number;
}

export interface StorageLocationCreateInput {
  name: string;
  racks: RackInput[];
}

export interface MovePositionResult {
  source: PositionRead;
  dest: PositionRead;
}

export type PositionEventKind = 'assign' | 'empty' | 'move_in' | 'move_out';

/** One row of a position's history (unit in / out / move). */
export interface PositionEventRead {
  id: string;
  event_kind: PositionEventKind;
  from_status: string | null;
  to_status: string | null;
  lot_number: string | null;
  actor_name: string | null;
  counterpart_label: string | null;
  counterpart_location: string | null;
  occurred_at: string;
}

/** Free/total rack positions for one location (only racked locations appear). */
export interface LocationCapacity {
  hasRacks: boolean;
  empty: number;
  total: number;
}

/**
 * Fold the storage tree (location → rack → position) into a per-location
 * id → capacity map. Only locations that own at least one rack are included;
 * everything else is ledger-only and uncapped. Mirrors the backend's
 * ``count_empty_positions`` (status === 'empty' across the location's racks),
 * which gates unit-in and the transfer destination leg.
 */
export function buildCapacityMap(
  storageLocs: StorageLocationRead[],
): Map<string, LocationCapacity> {
  const map = new Map<string, LocationCapacity>();
  for (const loc of storageLocs) {
    if (loc.racks.length === 0) continue;
    let empty = 0;
    let total = 0;
    for (const rack of loc.racks) {
      for (const pos of rack.positions) {
        total += 1;
        if (pos.status === 'empty') empty += 1;
      }
    }
    map.set(loc.id, { hasRacks: true, empty, total });
  }
  return map;
}

export const storageApi = {
  listLocations: (opts?: { activeOnly?: boolean; signal?: AbortSignal }) =>
    api.get<StorageLocationRead[]>('/storage/locations', {
      query: { active_only: opts?.activeOnly },
      signal: opts?.signal,
    }),

  createLocation: (input: StorageLocationCreateInput) =>
    api.post<StorageLocationRead>('/storage/locations', { json: input }),

  addRack: (locationId: string, input: RackInput) =>
    api.post<RackRead>(`/storage/locations/${locationId}/racks`, { json: input }),

  assign: (positionId: string, lotId: string, evidenceId: string) =>
    api.post<PositionRead>(`/storage/positions/${positionId}/assign`, {
      json: { lot_id: lotId, evidence_id: evidenceId },
    }),

  empty: (positionId: string, evidenceId: string, destination: string) =>
    api.post<PositionRead>(`/storage/positions/${positionId}/empty`, {
      json: { evidence_id: evidenceId, destination },
    }),

  move: (positionId: string, destPositionId: string) =>
    api.post<MovePositionResult>(`/storage/positions/${positionId}/move`, {
      json: { dest_position_id: destPositionId },
    }),

  positionHistory: (positionId: string, opts?: { signal?: AbortSignal }) =>
    api.get<PositionEventRead[]>(`/storage/positions/${positionId}/history`, {
      signal: opts?.signal,
    }),
};
