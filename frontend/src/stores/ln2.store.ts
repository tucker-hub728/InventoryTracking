'use client';

import { create } from 'zustand';

import {
  storageApi,
  type PositionRead,
  type RackRead,
  type StorageLocationRead,
} from '@/lib/api/storage';
import type { Position, Rack, StorageLocation } from '@/components/ln2/ln2-data';

/** One rack row defined while creating a location, shaped as a grid. */
export interface RackInput {
  name: string;
  rows: number;
  cols: number;
}

export interface AddLocationInput {
  name: string;
  racks: RackInput[];
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface LN2State {
  locations: StorageLocation[];
  status: LoadStatus;
  error: string | null;

  /** Fetch the full storage tree from the backend. */
  load: () => Promise<void>;
  /** Create a location with its racks; returns the new id for the caller. */
  addLocation: (input: AddLocationInput) => Promise<string>;
  /** Occupy an empty position with a lot (one vial). Requires e-sig evidence. */
  assignPosition: (positionId: string, lotId: string, evidenceId: string) => Promise<void>;
  /** Empty a position. Requires e-sig evidence + a destination (where it went). */
  emptyPosition: (
    positionId: string,
    evidenceId: string,
    destination: string,
  ) => Promise<void>;
}

// ── mappers: API read shapes → domain types ────────────────────────────

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30;

/** Whole months since an ISO timestamp (0 when never assigned). */
function monthsSince(iso: string | null): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / MS_PER_MONTH));
}

function mapPosition(p: PositionRead): Position {
  return {
    id: p.id,
    index: p.index,
    status: p.status === 'occupied' ? 'Occupied' : 'Empty',
    item: p.item_id
      ? {
          id: p.item_id,
          desc: p.item_description ?? '',
          vendor: p.vendor_name ?? '—',
        }
      : null,
    lot: p.lot_number,
    sinceMonths: monthsSince(p.assigned_at),
  };
}

function mapRack(r: RackRead): Rack {
  return {
    id: r.id,
    name: r.name,
    rows: r.rows,
    cols: r.cols,
    positions: r.positions.map(mapPosition),
  };
}

function mapLocation(l: StorageLocationRead): StorageLocation {
  return {
    id: l.id,
    name: l.name,
    kind: l.kind,
    detail: l.detail,
    racks: l.racks.map(mapRack),
  };
}

/** Immutably replace one position (by id) across the whole tree. */
function patchPosition(
  locations: StorageLocation[],
  updated: PositionRead,
): StorageLocation[] {
  const next = mapPosition(updated);
  return locations.map((loc) => ({
    ...loc,
    racks: loc.racks.map((rack) =>
      rack.positions.some((p) => p.id === next.id)
        ? { ...rack, positions: rack.positions.map((p) => (p.id === next.id ? next : p)) }
        : rack,
    ),
  }));
}

/**
 * LN2 / Storage store. API-backed: {@link load} fetches the tree once, and
 * every mutation calls the backend and patches the returned row into state.
 */
export const useLN2Store = create<LN2State>((set) => ({
  locations: [],
  status: 'idle',
  error: null,

  load: async () => {
    set({ status: 'loading', error: null });
    try {
      const data = await storageApi.listLocations();
      set({ locations: data.map(mapLocation), status: 'ready' });
    } catch (err) {
      set({
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to load storage',
      });
    }
  },

  addLocation: async (input) => {
    const created = await storageApi.createLocation({
      name: input.name,
      racks: input.racks,
    });
    const loc = mapLocation(created);
    set((state) => ({ locations: [...state.locations, loc] }));
    return loc.id;
  },

  assignPosition: async (positionId, lotId, evidenceId) => {
    const updated = await storageApi.assign(positionId, lotId, evidenceId);
    set((state) => ({ locations: patchPosition(state.locations, updated) }));
  },

  emptyPosition: async (positionId, evidenceId, destination) => {
    const updated = await storageApi.empty(positionId, evidenceId, destination);
    set((state) => ({ locations: patchPosition(state.locations, updated) }));
  },
}));
