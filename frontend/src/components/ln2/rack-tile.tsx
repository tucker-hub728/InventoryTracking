'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { GRID_COLUMNS, POSITION_TONE, rackOccupied, type Rack } from './ln2-data';

interface RackTileProps {
  rack: Rack;
  highlight: Set<string>;
  onSelectPosition: (rackKey: string, positionId: string) => void;
}

export const RackTile = React.memo(function RackTile({
  rack,
  highlight,
  onSelectPosition,
}: RackTileProps) {
  const occupied = rackOccupied(rack);

  return (
    <div className="rounded-md border border-border bg-bg-elev p-3 shadow-elev-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-xs font-semibold tracking-tight">{rack.name}</div>
        <div className="font-mono text-[11px] text-text-3">
          {occupied}/{rack.positions.length}
        </div>
      </div>
      <div
        role="grid"
        aria-label={`${rack.name} positions`}
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0,1fr))` }}
      >
        {rack.positions.map((pos) => {
          const tone = POSITION_TONE[pos.status];
          const highlighted = highlight.has(pos.id);
          return (
            <button
              key={pos.id}
              type="button"
              onClick={() => onSelectPosition(rack.id, pos.id)}
              aria-label={`Position ${pos.index} (${pos.status})`}
              title={pos.item ? `${pos.item.id} · ${pos.item.desc}` : pos.status}
              className={cn(
                'aspect-square rounded-sm text-[10px] font-medium leading-none transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                tone.cell,
                highlighted && 'ring-2 ring-offset-2 ring-offset-bg-elev ring-accent scale-105',
              )}
            >
              {pos.index}
            </button>
          );
        })}
      </div>
    </div>
  );
});
