'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import {
  POSITION_TONE,
  rackOccupied,
  type ItemColor,
  type Rack,
} from './ln2-data';

interface RackTileProps {
  rack: Rack;
  highlight: Set<string>;
  /** Item id → color, so every slot is tinted by what fills it. */
  colorMap: Map<string, ItemColor>;
  /** When a search is active, fade slots that don't match the query. */
  dimUnmatched?: boolean;
  onSelectPosition: (rackKey: string, positionId: string) => void;
}

export const RackTile = React.memo(function RackTile({
  rack,
  highlight,
  colorMap,
  dimUnmatched = false,
  onSelectPosition,
}: RackTileProps) {
  const occupied = rackOccupied(rack);

  return (
    <div className="rounded-md border border-border bg-bg-elev p-3 shadow-elev-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-semibold tracking-tight">{rack.name}</span>
          <span className="font-mono text-[10px] text-text-3">
            {rack.rows}×{rack.cols}
          </span>
        </div>
        <div className="font-mono text-[11px] text-text-3">
          {occupied}/{rack.positions.length}
        </div>
      </div>
      <div
        role="grid"
        aria-label={`${rack.name} positions`}
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${rack.cols}, minmax(0,1fr))` }}
      >
        {rack.positions.map((pos) => {
          const tone = POSITION_TONE[pos.status];
          const highlighted = highlight.has(pos.id);
          const color = pos.item ? colorMap.get(pos.item.id) : undefined;
          const dimmed = dimUnmatched && !highlighted;
          return (
            <button
              key={pos.id}
              type="button"
              onClick={() => onSelectPosition(rack.id, pos.id)}
              aria-label={
                pos.item
                  ? `Position ${pos.index}: ${pos.item.id}${pos.lot ? `, lot ${pos.lot}` : ''}`
                  : `Position ${pos.index} (Empty)`
              }
              title={
                pos.item
                  ? `Pos ${pos.index} · ${pos.item.id} · ${pos.item.desc}${pos.lot ? ` · Lot ${pos.lot}` : ''}`
                  : `Pos ${pos.index} · Empty`
              }
              style={color ? { backgroundColor: color.bg, color: color.fg } : undefined}
              className={cn(
                'relative flex aspect-square flex-col items-center justify-center overflow-hidden rounded-sm px-0.5 text-center font-medium leading-none transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                !color && tone.cell,
                dimmed && 'opacity-30',
                highlighted && 'ring-2 ring-offset-2 ring-offset-bg-elev ring-accent scale-105 !opacity-100',
              )}
            >
              {pos.item ? (
                <>
                  <span className="absolute left-0.5 top-0 font-mono text-[8px] opacity-60">
                    {pos.index}
                  </span>
                  <span className="w-full truncate text-[11px] font-semibold leading-tight">
                    {pos.item.id}
                  </span>
                  {pos.lot && (
                    <span className="w-full truncate text-[9px] leading-tight opacity-85">
                      {pos.lot}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-[10px]">{pos.index}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
});
