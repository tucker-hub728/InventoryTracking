import { seededRandom } from '@/lib/seeded-random';
import { mockData } from '@/lib/mock-data';
import type { InventoryItem } from '@/types/inventory';
import type { LocationKind } from '@/lib/api/locations';

/** Fixed column count for every rack grid; rows wrap as positions are added. */
export const GRID_COLUMNS = 5;
export const DEFAULT_RACKS = 6;
export const DEFAULT_POSITIONS_PER_RACK = 25;

export type PositionStatus = 'Occupied' | 'Reserved' | 'Quarantine' | 'Empty';

/** A single slot inside a rack. */
export interface Position {
  id: string;
  /** 1-based index within its rack. */
  index: number;
  status: PositionStatus;
  item: InventoryItem | null;
  lot: string | null;
  sinceMonths: number;
}

/** A rack holds an ordered list of positions. */
export interface Rack {
  id: string;
  name: string;
  positions: Position[];
}

/**
 * Every storage location now uses the SAME structure — rack → position —
 * regardless of kind (LN2 tank, fridge, lab bench, store room). The `kind`
 * only drives the header label and switcher icon, not the layout.
 */
export interface StorageLocation {
  id: string;
  name: string;
  kind: LocationKind;
  /** Sub-line shown in the header (temperature / context). */
  detail: string;
  racks: Rack[];
}

// ── id + factory helpers ─────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

export function rackId(locationId: string, index: number): string {
  return `${locationId}-R${pad(index)}`;
}

export function positionId(rackKey: string, index: number): string {
  return `${rackKey}-P${pad(index)}`;
}

/** A fresh, unoccupied position. */
export function emptyPosition(rackKey: string, index: number): Position {
  return {
    id: positionId(rackKey, index),
    index,
    status: 'Empty',
    item: null,
    lot: null,
    sinceMonths: 0,
  };
}

/** A new, empty rack with `positions` empty slots. Defaults to `Rack NN`. */
export function emptyRack(
  locationId: string,
  index: number,
  positions: number,
  name?: string,
): Rack {
  const key = rackId(locationId, index);
  return {
    id: key,
    name: name?.trim() || `Rack ${pad(index)}`,
    positions: Array.from({ length: positions }, (_, i) => emptyPosition(key, i + 1)),
  };
}

/** kebab-case slug for deriving a stable location id from its name. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'location'
  );
}

// ── deterministic demo seed ──────────────────────────────────────────────

const ITEM_POOL = mockData.items.filter(
  (i) =>
    i.id.startsWith('AY-') ||
    (i.id.startsWith('CM-') && /HUMAN|PBMC|donor|cell/i.test(i.desc)),
);

function rollStatus(r: number): PositionStatus {
  if (r < 0.55) return 'Occupied';
  if (r < 0.61) return 'Reserved';
  if (r < 0.65) return 'Quarantine';
  return 'Empty';
}

/**
 * Build the deterministic demo locations. Pure — no Date/random — so SSR and
 * the client produce identical output (no hydration mismatch). The store
 * seeds from this once, then all further edits live in memory.
 */
export function buildSeedLocations(): StorageLocation[] {
  let poolIdx = 0;

  const seedRack = (locationId: string, index: number, perRack: number): Rack => {
    const key = rackId(locationId, index);
    const rand = seededRandom(`${key}`);
    const positions: Position[] = [];
    for (let p = 1; p <= perRack; p++) {
      const status = rollStatus(rand());
      let item: InventoryItem | null = null;
      if ((status === 'Occupied' || status === 'Quarantine') && ITEM_POOL.length > 0) {
        item = ITEM_POOL[poolIdx % ITEM_POOL.length]!;
        poolIdx++;
      }
      positions.push({
        id: positionId(key, p),
        index: p,
        status,
        item,
        lot: item ? `L-2025${String(Math.floor(rand() * 9000) + 1000)}` : null,
        sinceMonths: Math.floor(rand() * 18) + 1,
      });
    }
    return { id: key, name: `Rack ${pad(index)}`, positions };
  };

  const make = (
    id: string,
    name: string,
    kind: LocationKind,
    detail: string,
    racks: number,
    perRack: number,
  ): StorageLocation => ({
    id,
    name,
    kind,
    detail,
    racks: Array.from({ length: racks }, (_, i) => seedRack(id, i + 1, perRack)),
  });

  return [
    make('ln2-tank-a', 'LN2 Tank A', 'LN2', 'Vapor-phase · ~ -196 °C', 6, 25),
    make('ln2-tank-b', 'LN2 Tank B', 'LN2', 'Vapor-phase · ~ -196 °C', 6, 25),
    make('ln2-tank-c', 'LN2 Tank C', 'LN2', 'Vapor-phase · ~ -196 °C', 6, 25),
    make('refrigerator-1', 'Refrigerator 1', 'fridge', 'Refrigerator · 2–8 °C', 3, 25),
    make('lab-bench', 'Lab Bench', 'room_temp', 'Room temperature', 2, 25),
    make('store-room', 'Store Room', 'other', 'Ambient · uncontrolled', 2, 25),
  ];
}

// ── stats + tones ─────────────────────────────────────────────────────────

export interface LocationStats {
  total: number;
  occupied: number;
  reserved: number;
  quarantine: number;
  empty: number;
}

export function computeStats(location: StorageLocation): LocationStats {
  const stats: LocationStats = { total: 0, occupied: 0, reserved: 0, quarantine: 0, empty: 0 };
  for (const rack of location.racks) {
    for (const pos of rack.positions) {
      stats.total += 1;
      if (pos.status === 'Occupied') stats.occupied += 1;
      else if (pos.status === 'Reserved') stats.reserved += 1;
      else if (pos.status === 'Quarantine') stats.quarantine += 1;
      else stats.empty += 1;
    }
  }
  return stats;
}

export function rackOccupied(rack: Rack): number {
  return rack.positions.filter((p) => p.status === 'Occupied').length;
}

export const POSITION_TONE: Record<
  PositionStatus,
  { cell: string; legend: string; label: string }
> = {
  Occupied: { cell: 'bg-accent text-white', legend: 'bg-accent', label: 'Occupied' },
  Reserved: { cell: 'bg-warning-soft text-warning', legend: 'bg-warning-soft border border-warning/40', label: 'Reserved' },
  Quarantine: { cell: 'bg-danger-soft text-danger', legend: 'bg-danger-soft border border-danger/40', label: 'Quarantine' },
  Empty: { cell: 'bg-bg-elev text-text-3 border border-border-strong', legend: 'bg-bg-elev border border-border-strong', label: 'Empty' },
};
