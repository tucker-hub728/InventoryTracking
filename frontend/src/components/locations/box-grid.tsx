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

/** Cell label — the lot number's trailing identifier, kept long enough that
 *  sibling lots (e.g. ``PO-AA-001`` vs ``PO-BB-001``) stay distinguishable.
 *  Falls back to the item number. The full lot is on the cell's hover tooltip
 *  and the Contents list; the cell is too small to fit the whole name. */
function cellToken(a: Allocation): string {
  const src = a.lot_number ?? a.item_number ?? '';
  if (!src) return '•';
  if (src.length <= 6) return src;
  // Last 6 chars, minus any leading separator so it doesn't read like "-B-011".
  return src.slice(-6).replace(/^[-_\s]+/, '');
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
  /**
   * The lot a batch selection is bound to. While set, occupied cells holding a
   * DIFFERENT lot render dimmed and disabled — a batch must be a single lot, and
   * the grid should say so before the click rather than after it.
   *
   * Null / undefined means nothing is selected yet, so every unit is fair game.
   */
  batchLotId?: string | null;
  /**
   * Empty cells (``"row:col"`` keys) already spoken for by a DIFFERENT part of
   * the same unsaved form — the transfer dialog aims several rows at one box,
   * and nothing on the server knows about a claim until it is signed. Rendered
   * as taken and not clickable, so the clash is visible while choosing instead
   * of surfacing as a validation error after the fact.
   */
  reservedCells?: Set<string>;
  onSelectCell?: (cell: {
    row: number;
    col: number;
    occupant: Allocation | null;
  }) => void;
}

/**
 * A Box's grid (the unit map; "vial map" in Requirements v2 §4.1). Occupied cells show the
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
  batchLotId,
  reservedCells,
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
                // Holds a unit, but not one that can join the batch under way.
                const otherLot = !!occ && !!batchLotId && occ.lot_id !== batchLotId;
                // Claimed by another row of the same form — empty on the
                // server, but not available to THIS selection.
                const reserved =
                  !occ && !isMulti && (reservedCells?.has(`${row}:${col}`) ?? false);
                const blocked = otherLot || reserved;
                const address = `${rowLabel(row)}${col}`;
                return (
                  <button
                    key={`${row}:${col}`}
                    type="button"
                    disabled={blocked}
                    aria-disabled={blocked || undefined}
                    onClick={() => onSelectCell?.({ row, col, occupant: occ })}
                    title={
                      otherLot
                        ? `${address} · ${occ.lot_number ?? 'another lot'} — a batch must be a single lot`
                        : reserved
                          ? `${address} · already taken by another row of this transfer`
                          : occ
                            ? `${address} · ${occ.item_number ?? ''} ${occ.lot_number ?? ''}`.trim()
                            : `${address} · empty`
                    }
                    className={cn(
                      'flex aspect-square min-h-[2.25rem] items-center justify-center overflow-hidden rounded px-px font-mono text-[10px] leading-none tracking-tight transition-colors',
                      otherLot
                        ? // Still legibly a unit — a faded fill rather than a
                          // washed-out one, so the token stays readable in both
                          // themes and the cell doesn't read as empty.
                          'cursor-not-allowed border border-accent/20 bg-accent/15 text-accent/60'
                        : reserved
                          ? 'cursor-not-allowed border border-dashed border-accent/30 bg-accent/10 text-accent/50'
                          : occ
                            ? 'bg-accent text-white hover:brightness-110'
                            : isMulti
                              ? 'border border-accent bg-accent/15 text-accent'
                              : 'border border-dashed border-border text-text-3 hover:border-accent hover:text-accent',
                      !blocked &&
                        (isSel || isMulti || isOccSel) &&
                        'ring-2 ring-accent ring-offset-1 ring-offset-bg',
                      isOccSel && 'ring-warning',
                    )}
                  >
                    {occ ? cellToken(occ) : reserved ? '·' : ''}
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
