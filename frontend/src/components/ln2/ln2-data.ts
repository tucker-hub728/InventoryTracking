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

// ── per-item color coding ─────────────────────────────────────────────────
//
// A uniform "occupied" blue can't tell you *what* fills a slot. We give every
// distinct item its own color so the grid reads at a glance, with the item
// code + lot printed in the cell as the source of truth (colors may repeat
// once there are more items than palette entries — the label disambiguates).

export interface ItemColor {
  /** Cell fill. */
  bg: string;
  /** Readable text on top of `bg`. */
  fg: string;
}

/**
 * Categorical palette — distinct hues, each dark enough for white text and
 * legible on both the light and dark app themes. Inline-styled (not Tailwind
 * classes) so the JIT compiler can't purge the dynamic colors.
 */
export const ITEM_PALETTE: readonly ItemColor[] = [
  { bg: '#4f46e5', fg: '#ffffff' }, // indigo
  { bg: '#0d9488', fg: '#ffffff' }, // teal
  { bg: '#b45309', fg: '#ffffff' }, // amber
  { bg: '#be123c', fg: '#ffffff' }, // rose
  { bg: '#7c3aed', fg: '#ffffff' }, // violet
  { bg: '#047857', fg: '#ffffff' }, // emerald
  { bg: '#0369a1', fg: '#ffffff' }, // sky
  { bg: '#c2410c', fg: '#ffffff' }, // orange
  { bg: '#a21caf', fg: '#ffffff' }, // fuchsia
  { bg: '#4d7c0f', fg: '#ffffff' }, // lime
  { bg: '#0e7490', fg: '#ffffff' }, // cyan
  { bg: '#b91c1c', fg: '#ffffff' }, // red
  { bg: '#1d4ed8', fg: '#ffffff' }, // blue
  { bg: '#15803d', fg: '#ffffff' }, // green
  { bg: '#9d174d', fg: '#ffffff' }, // pink
  { bg: '#57534e', fg: '#ffffff' }, // stone
];

/**
 * Assign each distinct item in a location a stable color. Items are sorted by
 * id first so the mapping stays put across data refreshes (a given item keeps
 * its color even as positions fill or empty).
 */
export function buildItemColorMap(location: StorageLocation): Map<string, ItemColor> {
  const ids = new Set<string>();
  for (const rack of location.racks) {
    for (const pos of rack.positions) {
      if (pos.item) ids.add(pos.item.id);
    }
  }
  const map = new Map<string, ItemColor>();
  [...ids]
    .sort()
    .forEach((id, i) => map.set(id, ITEM_PALETTE[i % ITEM_PALETTE.length]!));
  return map;
}

/** One row in the grid legend — an item, its color, slot count, and lots. */
export interface ItemLegendEntry {
  id: string;
  desc: string;
  color: ItemColor;
  /** How many positions this item occupies in the location. */
  count: number;
  /** Distinct lot numbers seen for this item (sorted). */
  lots: string[];
}

/** Aggregate occupied positions into legend rows, ordered by slot count desc. */
export function buildItemLegend(
  location: StorageLocation,
  colorMap: Map<string, ItemColor>,
): ItemLegendEntry[] {
  const acc = new Map<string, ItemLegendEntry & { lotSet: Set<string> }>();
  for (const rack of location.racks) {
    for (const pos of rack.positions) {
      if (!pos.item) continue;
      let entry = acc.get(pos.item.id);
      if (!entry) {
        entry = {
          id: pos.item.id,
          desc: pos.item.desc,
          color: colorMap.get(pos.item.id) ?? ITEM_PALETTE[0]!,
          count: 0,
          lots: [],
          lotSet: new Set(),
        };
        acc.set(pos.item.id, entry);
      }
      entry.count += 1;
      if (pos.lot) entry.lotSet.add(pos.lot);
    }
  }
  return [...acc.values()]
    .map(({ lotSet, ...e }) => ({ ...e, lots: [...lotSet].sort() }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}
