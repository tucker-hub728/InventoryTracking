'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import type { Allocation } from '@/lib/api/location-nodes';

/** Row label: 1→A … 26→Z, then 27→AA. Mirrors the physical cryo-box labels. */
export function rowLabel(row1Based: number): string {
  let n = row1Based;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Short token for a cell — the item number's trailing segment, else lot. */
function cellToken(a: Allocation): string {
  if (a.item_number) {
    const tail = a.item_number.split(/[-_\s]/).pop() ?? a.item_number;
    return tail.slice(-4);
  }
  if (a.lot_number) return a.lot_number.slice(-4);
  return '•';
}

export interface BoxGridProps {
  rows: number;
  cols: number;
  allocations: Allocation[];
  /** Currently highlighted cell, e.g. the one being placed/inspected. */
  selected?: { row: number; col: number } | null;
  /** Multi-selected empty cells (``"row:col"`` keys) for batch placement. */
  selectedCells?: Set<string>;
  /** Multi-selected occupied cells (``"row:col"`` keys) for batch unit-out. */
  selectedOccupied?: Set<string>;
  onSelectCell?: (cell: {
    row: number;
    col: number;
    occupant: Allocation | null;
  }) => void;
}

/**
 * A Box's grid (the "vial map", Requirements v2 §4.1). Occupied cells show the
 * item/lot token; empty cells are click targets for manual placement. Clicking
 * any cell calls ``onSelectCell`` with the (row, col) and its occupant (if any)
 * — the lowest level of the hierarchy with click-through to detail.
 */
export function BoxGrid({
  rows,
  cols,
  allocations,
  selected,
  selectedCells,
  selectedOccupied,
  onSelectCell,
}: BoxGridProps) {
  const occupied = React.useMemo(() => {
    const m = new Map<string, Allocation>();
    for (const a of allocations) {
      if (a.is_active && a.grid_row != null && a.grid_col != null) {
        m.set(`${a.grid_row}:${a.grid_col}`, a);
      }
    }
    return m;
  }, [allocations]);

  // Column-template: a row-label gutter + N equal columns.
  const template = `1.75rem repeat(${cols}, minmax(2.25rem, 1fr))`;

  return (
    <div className="overflow-x-auto">
      <div className="inline-grid gap-1" style={{ gridTemplateColumns: template }}>
        {/* Header row: blank corner + column numbers. */}
        <span aria-hidden />
        {Array.from({ length: cols }, (_, c) => (
          <span
            key={`h-${c}`}
            className="text-center text-[11px] font-medium text-text-3"
          >
            {c + 1}
          </span>
        ))}

        {/* Body rows. */}
        {Array.from({ length: rows }, (_, r) => {
          const row = r + 1;
          return (
            <React.Fragment key={`r-${row}`}>
              <span className="flex items-center justify-center text-[11px] font-medium text-text-3">
                {rowLabel(row)}
              </span>
              {Array.from({ length: cols }, (_, c) => {
                const col = c + 1;
                const occ = occupied.get(`${row}:${col}`) ?? null;
                const isSel = selected?.row === row && selected?.col === col;
                const isMulti = !occ && (selectedCells?.has(`${row}:${col}`) ?? false);
                const isOccSel = !!occ && (selectedOccupied?.has(`${row}:${col}`) ?? false);
                return (
                  <button
                    key={`${row}:${col}`}
                    type="button"
                    onClick={() => onSelectCell?.({ row, col, occupant: occ })}
                    title={
                      occ
                        ? `${rowLabel(row)}${col} · ${occ.item_number ?? ''} ${occ.lot_number ?? ''}`.trim()
                        : `${rowLabel(row)}${col} · empty`
                    }
                    className={cn(
                      'flex aspect-square min-h-[2.25rem] items-center justify-center rounded text-[11px] font-mono transition-colors',
                      occ
                        ? 'bg-accent text-white hover:brightness-110'
                        : isMulti
                          ? 'border border-accent bg-accent/15 text-accent'
                          : 'border border-dashed border-border text-text-3 hover:border-accent hover:text-accent',
                      (isSel || isMulti || isOccSel) && 'ring-2 ring-accent ring-offset-1 ring-offset-bg',
                      isOccSel && 'ring-warning',
                    )}
                  >
                    {occ ? cellToken(occ) : ''}
                  </button>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
