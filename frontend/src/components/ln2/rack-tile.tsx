'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import {
  LN2_GRID_SIZE,
  LN2_POSITIONS_PER_RACK,
  POSITION_TONE,
  positionKey,
  type LN2Map,
  type LN2Tank,
} from './ln2-data';

interface RackTileProps {
  tank: LN2Tank;
  rackNum: number;
  map: LN2Map;
  highlight: Set<string>;
  onSelect: (key: string) => void;
}

export const RackTile = React.memo(function RackTile({
  tank,
  rackNum,
  map,
  highlight,
  onSelect,
}: RackTileProps) {
  const occupied = React.useMemo(
    () =>
      Array.from({ length: LN2_POSITIONS_PER_RACK }).filter((_, i) => {
        const k = positionKey(tank, rackNum, i + 1);
        return map[k]?.status === 'Occupied';
      }).length,
    [tank, rackNum, map],
  );

  return (
    <div className="rounded-md border border-border bg-bg-elev p-3 shadow-elev-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-xs font-semibold tracking-tight">Rack {String(rackNum).padStart(2, '0')}</div>
        <div className="font-mono text-[11px] text-text-3">
          {occupied}/{LN2_POSITIONS_PER_RACK}
        </div>
      </div>
      <div
        role="grid"
        aria-label={`Tank ${tank} rack ${rackNum} positions`}
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${LN2_GRID_SIZE}, minmax(0,1fr))` }}
      >
        {Array.from({ length: LN2_POSITIONS_PER_RACK }).map((_, i) => {
          const pos = i + 1;
          const key = positionKey(tank, rackNum, pos);
          const info = map[key];
          if (!info) return null;
          const tone = POSITION_TONE[info.status];
          const highlighted = highlight.has(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(key)}
              aria-label={`Position ${key} (${info.status})`}
              title={info.item ? `${info.item.id} · ${info.item.desc}` : info.status}
              className={cn(
                'aspect-square rounded-sm text-[10px] font-medium leading-none transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                tone.cell,
                highlighted &&
                  'ring-2 ring-offset-2 ring-offset-bg-elev ring-accent scale-105',
              )}
            >
              {pos}
            </button>
          );
        })}
      </div>
    </div>
  );
});
