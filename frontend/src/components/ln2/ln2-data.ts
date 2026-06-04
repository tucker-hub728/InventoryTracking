/**
 * Domain types + presentation helpers for the Storage (LN2) grid.
 *
 * The live data is API-backed — see ``@/lib/api/storage`` and
 * ``@/stores/ln2.store``. This module is now pure types + view helpers
 * (no seeding / no in-memory factories).
 */

import type { LocationKind } from '@/lib/api/locations';

/** Binary slot status. A slot is either filled or not. */
export type PositionStatus = 'Occupied' | 'Empty';

/** The item occupying a slot — the minimal subset the UI renders. */
export interface PositionItem {
  /** Human item number, e.g. ``CM-0001``. What ``/inventory/{id}`` keys on. */
  id: string;
  desc: string;
  vendor: string;
}

/** A single slot inside a rack. */
export interface Position {
  id: string;
  /** 1-based row-major number within its rack (matches the cell label). */
  index: number;
  status: PositionStatus;
  item: PositionItem | null;
  lot: string | null;
  sinceMonths: number;
}

/** A rack holds a `rows × cols` grid of positions (row-major). */
export interface Rack {
  id: string;
  name: string;
  rows: number;
  cols: number;
  positions: Position[];
}

/**
 * Every storage location uses the SAME structure — rack → position —
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

// ── stats + tones ─────────────────────────────────────────────────────────

export interface LocationStats {
  total: number;
  occupied: number;
  empty: number;
}

export function computeStats(location: StorageLocation): LocationStats {
  const stats: LocationStats = { total: 0, occupied: 0, empty: 0 };
  for (const rack of location.racks) {
    for (const pos of rack.positions) {
      stats.total += 1;
      if (pos.status === 'Occupied') stats.occupied += 1;
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
  Empty: {
    cell: 'bg-bg-elev text-text-3 border border-border-strong',
    legend: 'bg-bg-elev border border-border-strong',
    label: 'Empty',
  },
};
