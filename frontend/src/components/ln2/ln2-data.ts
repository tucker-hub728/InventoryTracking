import { seededRandom } from '@/lib/seeded-random';
import { mockData } from '@/lib/mock-data';
import type { InventoryItem } from '@/types/inventory';

export const LN2_TANKS = ['A', 'B', 'C'] as const;
export const LN2_RACKS_PER_TANK = 6;
export const LN2_POSITIONS_PER_RACK = 25;
export const LN2_GRID_SIZE = 5;

export type LN2Tank = (typeof LN2_TANKS)[number];
export type PositionStatus = 'Occupied' | 'Reserved' | 'Quarantine' | 'Empty';

export interface PositionInfo {
  status: PositionStatus;
  item: InventoryItem | null;
  lot: string | null;
  sinceMonths: number;
}

export type LN2Map = Record<string, PositionInfo>;

export function positionKey(tank: LN2Tank, rack: number, pos: number): string {
  return `LN2-${tank}-${String(rack).padStart(2, '0')}-${String(pos).padStart(2, '0')}`;
}

/**
 * Build a deterministic occupancy map for the demo. Pure function — given
 * the same data + tanks, always returns the same layout.
 */
export function buildLN2Map(): LN2Map {
  const pool = mockData.items.filter(
    (i) =>
      i.id.startsWith('AY-') ||
      (i.id.startsWith('CM-') && /HUMAN|PBMC|donor|cell/i.test(i.desc)),
  );
  const map: LN2Map = {};
  let poolIdx = 0;

  LN2_TANKS.forEach((tank) => {
    const rand = seededRandom(`tank-${tank}`);
    for (let rack = 1; rack <= LN2_RACKS_PER_TANK; rack++) {
      for (let pos = 1; pos <= LN2_POSITIONS_PER_RACK; pos++) {
        const key = positionKey(tank, rack, pos);
        const r = rand();
        let status: PositionStatus;
        if (r < 0.55) status = 'Occupied';
        else if (r < 0.61) status = 'Reserved';
        else if (r < 0.65) status = 'Quarantine';
        else status = 'Empty';

        let item: InventoryItem | null = null;
        if ((status === 'Occupied' || status === 'Quarantine') && pool.length > 0) {
          item = pool[poolIdx % pool.length]!;
          poolIdx++;
        }
        map[key] = {
          status,
          item,
          lot: item ? `L-2025${String(Math.floor(rand() * 9000) + 1000)}` : null,
          sinceMonths: Math.floor(rand() * 18) + 1,
        };
      }
    }
  });
  return map;
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
