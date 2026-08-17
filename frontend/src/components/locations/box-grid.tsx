'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import type { Allocation } from '@/lib/api/location-nodes';
import { RELEASE_STATE_LABEL } from '@/lib/api/lots';

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

/** A lot's identity within one box: its cell token, and what to call it. */
interface LotFacet {
  /** Position in the legend — lots stay in a stable, lot-number order. */
  order: number;
  token: string;
  lotNumber: string | null;
  itemNumber: string | null;
  count: number;
}

/**
 * Give every lot in the box the SHORTEST token that still tells it apart from
 * its neighbours.
 *
 * The old label was a blind "last 6 characters", which is both too long for a
 * 2.25rem cell (it overflowed and got clipped mid-token) and not necessarily
 * unique. Here the suffix grows only until every lot in THIS box is distinct,
 * so a box holding `L-0921` and `L-0212` shows `921` / `212` and one holding a
 * single lot shows two characters. The full number is always a hover away, and
 * spelled out in the legend.
 */
function buildFacets(allocations: Allocation[]): Map<string, LotFacet> {
  const lots = new Map<string, { lotNumber: string | null; itemNumber: string | null; count: number }>();
  for (const a of allocations) {
    if (!a.is_active || a.grid_row == null || a.grid_col == null) continue;
    const seen = lots.get(a.lot_id);
    if (seen) seen.count += 1;
    else lots.set(a.lot_id, { lotNumber: a.lot_number, itemNumber: a.item_number, count: 1 });
  }

  // Sorted by lot number so the legend doesn't reshuffle when an allocation is
  // added, removed, or simply comes back from the API in another order.
  const ids = [...lots.keys()].sort((x, y) => {
    const lx = lots.get(x)!.lotNumber ?? x;
    const ly = lots.get(y)!.lotNumber ?? y;
    return lx.localeCompare(ly);
  });

  const source = (id: string) => {
    const l = lots.get(id)!;
    return (l.lotNumber ?? l.itemNumber ?? id).trim();
  };
  // Shortest suffix length that keeps every lot in this box distinguishable.
  let width = 2;
  for (; width < 7; width++) {
    const tokens = new Set(ids.map((id) => source(id).slice(-width)));
    if (tokens.size === ids.length) break;
  }

  const facets = new Map<string, LotFacet>();
  ids.forEach((id, i) => {
    const l = lots.get(id)!;
    const token = source(id).slice(-width).replace(/^[-_\s]+/, '') || '•';
    facets.set(id, { order: i, token, lotNumber: l.lotNumber, itemNumber: l.itemNumber, count: l.count });
  });
  return facets;
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
  /** Show the lot legend under the map. Off for the compact inline picker,
   *  where the map is a control rather than something to read. */
  showLegend?: boolean;
  onSelectCell?: (cell: {
    row: number;
    col: number;
    occupant: Allocation | null;
  }) => void;
}

/**
 * A Box's grid (the unit map; "vial map" in Requirements v2 §4.1).
 *
 * Every unit is one block of accent, stamped with a token only as long as it
 * needs to be to separate the lots actually in this box — the old label was a
 * blind last-six-characters that overflowed the cell and got clipped
 * (client 2026-08-17). Picking a lot, or just pointing at it in the legend,
 * greys every other one out, so a single holding can be traced across the box
 * at a glance and the full lot numbers have somewhere to be written out.
 *
 * Nothing here changes size on hover or selection — emphasis is carried by
 * colour and by rings, which draw outside the layout box. A grid that reflowed
 * under the cursor would move the very cell being aimed at.
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
  showLegend = false,
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

  const facets = React.useMemo(() => buildFacets(allocations), [allocations]);

  // A lot the operator is pointing at in the legend. Peeking only — it never
  // changes what is selected, so moving the mouse away puts the map back.
  const [peekLot, setPeekLot] = React.useState<string | null>(null);
  // The batch under way wins: while one is open the rule (single lot) is real,
  // not a preview.
  const focusLot = batchLotId ?? peekLot;

  // Column-template: a row-label gutter + N equal columns.
  const template = `1.75rem repeat(${cols}, minmax(2.25rem, 1fr))`;

  const legend = React.useMemo(
    () => [...facets.entries()].sort((a, b) => a[1].order - b[1].order),
    [facets],
  );

  return (
    <div className="space-y-2.5">
      <div className="overflow-x-auto">
        {/* ``p-1`` is load-bearing: a selection ring is drawn OUTSIDE the cell's
            box (2px ring + 1px offset), and this scroller clips at its own
            edge — so without a gutter the ring on any edge cell, most visibly
            the bottom row, is sliced in half. The padding belongs on the grid
            rather than the scroller so the ring sits inside scrollable content
            instead of relying on end-padding behaviour in a scroll container. */}
        <div className="inline-grid gap-1 p-1" style={{ gridTemplateColumns: template }}>
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
                  const facet = occ ? facets.get(occ.lot_id) : undefined;
                  const isSel = selected?.row === row && selected?.col === col;
                  const isMulti = !occ && (selectedCells?.has(`${row}:${col}`) ?? false);
                  const isOccSel = !!occ && (selectedOccupied?.has(`${row}:${col}`) ?? false);
                  // Holds a unit, but not one that can join the batch under way.
                  const otherLot = !!occ && !!batchLotId && occ.lot_id !== batchLotId;
                  // Greyed because ANOTHER lot has the focus — includes the
                  // batch case above, plus a plain legend peek.
                  const muted = !!occ && !!focusLot && occ.lot_id !== focusLot;
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
                              ? [
                                  address,
                                  `${occ.item_number ?? ''} ${occ.lot_number ?? ''}`.trim(),
                                  // Only for lots that carry one — consumables
                                  // in an LN2 box have no release workflow.
                                  occ.release_state
                                    ? RELEASE_STATE_LABEL[occ.release_state]
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')
                              : `${address} · empty`
                      }
                      className={cn(
                        'flex aspect-square min-h-[2.25rem] items-center justify-center overflow-hidden rounded px-px font-mono text-[10px] leading-none tracking-tight transition-colors',
                        occ
                          ? muted
                            ? // A real grey, not a washed-out blue: the point is
                              // that these units are NOT the one being traced.
                              cn(
                                'border border-border bg-surface-2 text-text-3',
                                otherLot && 'cursor-not-allowed',
                              )
                            : 'bg-accent text-white hover:brightness-110'
                          : reserved
                            ? 'cursor-not-allowed border border-dashed border-accent/30 bg-accent/10 text-accent/50'
                            : isMulti
                              ? 'border border-accent bg-accent/15 text-accent'
                              : 'border border-dashed border-border text-text-3 hover:border-accent hover:text-accent',
                        // Rings, never borders or scale — they paint outside the
                        // layout box, so nothing reflows on selection.
                        !blocked &&
                          (isSel || isMulti || isOccSel) &&
                          // Offset against the CARD's background, not the page's
                          // — they are the same white in light mode but not in
                          // dark, where the gap read as a darker halo.
                          'ring-2 ring-accent ring-offset-1 ring-offset-bg-elev',
                        isOccSel && 'ring-warning',
                      )}
                    >
                      {occ ? (facet?.token ?? '•') : reserved ? '·' : ''}
                    </button>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Legend: the one place a lot number is written out in full — the cells
          only have room for the tail of it. Pointing at a chip traces that lot
          through the map above and greys the rest. */}
      {showLegend && legend.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5 border-t border-border pt-2.5"
          onMouseLeave={() => setPeekLot(null)}
        >
          {legend.map(([lotId, f]) => {
            const isFocus = focusLot === lotId;
            const dimmed = !!focusLot && !isFocus;
            return (
              <li key={lotId}>
                <button
                  type="button"
                  onMouseEnter={() => setPeekLot(lotId)}
                  onFocus={() => setPeekLot(lotId)}
                  onBlur={() => setPeekLot(null)}
                  title={`${f.itemNumber ?? ''} ${f.lotNumber ?? ''} · ${f.count} unit${
                    f.count === 1 ? '' : 's'
                  }`.trim()}
                  className={cn(
                    'flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    isFocus
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-text-2 hover:border-accent/50',
                    dimmed && 'opacity-50',
                  )}
                >
                  <span className="font-mono">{f.lotNumber ?? f.itemNumber ?? '—'}</span>
                  <span className="tabular-nums text-text-3">{f.count}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
