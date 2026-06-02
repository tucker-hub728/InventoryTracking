'use client';

import { create } from 'zustand';

import type { LocationKind } from '@/lib/api/locations';
import {
  buildSeedLocations,
  emptyRack,
  slugify,
  type Position,
  type StorageLocation,
} from '@/components/ln2/ln2-data';

/** One rack row defined while creating a location. */
export interface RackInput {
  name: string;
  positions: number;
}

export interface AddLocationInput {
  name: string;
  kind: LocationKind;
  detail: string;
  racks: RackInput[];
}

interface LN2State {
  locations: StorageLocation[];

  /** Create a location with the given racks (each with its own name +
   *  position count). Returns the new location id so the caller can switch. */
  addLocation: (input: AddLocationInput) => string;
  /** Patch a single position (status / item / lot …). */
  updatePosition: (
    locationId: string,
    rackKey: string,
    positionId: string,
    patch: Partial<Position>,
  ) => void;
}

/** Ensure a slug is unique against the existing location ids. */
function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * LN2 / storage store. Demo-only: seeded once from {@link buildSeedLocations}
 * and mutated entirely in memory — no backend, no persistence. The whole
 * rack layout is defined up front when the location is created.
 */
export const useLN2Store = create<LN2State>((set, get) => ({
  locations: buildSeedLocations(),

  addLocation: (input) => {
    const taken = new Set(get().locations.map((l) => l.id));
    const id = uniqueId(slugify(input.name), taken);
    const racks = input.racks.map((r, i) =>
      emptyRack(id, i + 1, Math.max(1, r.positions), r.name),
    );
    const location: StorageLocation = {
      id,
      name: input.name.trim(),
      kind: input.kind,
      detail: input.detail.trim(),
      racks,
    };
    set((state) => ({ locations: [...state.locations, location] }));
    return id;
  },

  updatePosition: (locationId, rackKey, positionId, patch) => {
    set((state) => ({
      locations: state.locations.map((loc) => {
        if (loc.id !== locationId) return loc;
        return {
          ...loc,
          racks: loc.racks.map((rack) => {
            if (rack.id !== rackKey) return rack;
            return {
              ...rack,
              positions: rack.positions.map((pos) =>
                pos.id === positionId ? { ...pos, ...patch } : pos,
              ),
            };
          }),
        };
      }),
    }));
  },
}));
