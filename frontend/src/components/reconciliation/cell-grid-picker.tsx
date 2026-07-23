'use client';

import * as React from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import { expiryStatus } from '@/lib/inventory-helpers';
import { locationNodesApi } from '@/lib/api/location-nodes';
import type { CellOption } from '@/lib/api/kits';

/**
 * Pick individual cells inside an LN2 box.
 *
 * A cryobox cell holds exactly one unit of one lot (`uq_lot_allocations_cell`),
 * so for LN2 the quantity is a consequence of which cells you picked — never a
 * number you type. See `docs/modules/kitting-ln2-cells-build.md`.
 *
 * Selection happens at cell level; the *recorded* location stays the box (D4),
 * which is why nothing here is written back to a movement — the parent sends
 * either allocation ids (source) or row/col pairs (destination).
 *
 * `value` holds opaque keys, built by {@link cellKey}: the allocation id when
 * picking what to take out, `"row:col"` when picking where to put things back.
 */
export function cellKey(mode: CellMode, cell: { allocation_id?: string; grid_row: number; grid_col: number }) {
  return mode === 'source' ? (cell.allocation_id as string) : `${cell.grid_row}:${cell.grid_col}`;
}

export type CellMode = 'source' | 'destination';

/** Shared empty set so an omitted `reserved` prop keeps a stable reference. */
const EMPTY_KEYS: Set<string> = new Set();

/**
 * Human position label, following the cryobox / microplate convention the lab
 * already uses: row letter + column number, `A1` … `J10`.
 *
 * A single-column box is a *cassette* — physically a vertical stack, not a
 * grid — so its positions are plain slot numbers. Rows beyond Z fall back to
 * numbers rather than inventing `AA`.
 */
export function positionLabel(row: number, col: number, cols: number): string {
  if (cols === 1) return String(row);
  return `${rowLabel(row)}${col}`;
}

/** Row axis label: `A`…`Z`, then plain numbers rather than inventing `AA`. */
function rowLabel(row: number): string {
  return row <= 26 ? String.fromCharCode(64 + row) : String(row);
}

export function CellGridPicker({
  mode,
  rows,
  cols,
  cells,
  value,
  onChange,
  max,
  reserved,
  disabled = false,
  nearExpiryDays = 30,
  className,
}: {
  mode: CellMode;
  rows: number;
  cols: number;
  /** Currently occupied cells. Selectable in `source` mode, blocked in `destination`. */
  cells: CellOption[];
  value: string[];
  onChange: (next: string[]) => void;
  /** Cap on how many may be selected — the quantity being moved. */
  max?: number;
  /** `"row:col"` cells claimed by ANOTHER picker on the same box in this form
   *  (a split-output row, a back-flush line). Blocked in `destination` mode so
   *  two placements can't fight over one physical cell. */
  reserved?: Set<string>;
  disabled?: boolean;
  /** Window for the amber "near expiry" tint on source cells. */
  nearExpiryDays?: number;
  className?: string;
}) {
  const occupied = React.useMemo(() => {
    const m = new Map<string, CellOption>();
    for (const c of cells) m.set(`${c.grid_row}:${c.grid_col}`, c);
    return m;
  }, [cells]);

  const selected = React.useMemo(() => new Set(value), [value]);
  const reservedSet = reserved ?? EMPTY_KEYS;
  const atLimit = max !== undefined && value.length >= max;
  const complete = max !== undefined && value.length === max;
  // A single-column box is a cassette: a vertical stack, so it has no column axis.
  const isCassette = cols <= 1;

  const rowList = React.useMemo(
    () => Array.from({ length: Math.max(1, rows) }, (_, i) => i + 1),
    [rows],
  );
  const colList = React.useMemo(
    () => Array.from({ length: Math.max(1, cols) }, (_, i) => i + 1),
    [cols],
  );

  const toggle = (key: string) => {
    if (disabled) return;
    if (selected.has(key)) onChange(value.filter((k) => k !== key));
    else if (!atLimit) onChange([...value, key]);
  };

  // Positions in the order they were picked. The operator copies these onto the
  // batch record, so show them rather than only a count.
  const chosen = React.useMemo(
    () =>
      value.map((key) => {
        const hit = cells.find((c) =>
          mode === 'source' ? c.allocation_id === key : `${c.grid_row}:${c.grid_col}` === key,
        );
        if (hit) return positionLabel(hit.grid_row, hit.grid_col, cols);
        const [r, c] = key.split(':');
        return positionLabel(Number(r ?? 0), Number(c ?? 0), cols);
      }),
    [value, cells, mode, cols],
  );

  const freeCount =
    rows * cols - occupied.size - (mode === 'destination' ? reservedSet.size : 0);

  return (
    <div className={cn('space-y-2.5', className)}>
      {/* Heading: what to do, and how far along. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-xs text-text-3">
          {mode === 'source'
            ? 'Select the vials to pull — each position holds one unit.'
            : 'Select free positions — each holds one unit.'}
        </p>
        <span
          className={cn(
            'shrink-0 font-mono text-xs font-medium tabular-nums',
            complete ? 'text-success' : 'text-text-3',
          )}
        >
          {value.length}
          {max !== undefined ? ` / ${max}` : ''} selected
        </span>
      </div>

      {/* The box itself — inset panel so it reads as looking down into a rack. */}
      <div className="overflow-x-auto">
        {/* A group of toggle buttons laid out as a grid — deliberately NOT
            role="grid", which would promise arrow-key cell navigation this
            doesn't implement. Each cell is a real button with aria-pressed. */}
        <div
          role="group"
          aria-label={`Storage box positions, ${rows} by ${cols}`}
          className="inline-block rounded-lg border border-border-strong bg-surface p-2 shadow-inner"
        >
          <div
            className="grid gap-[3px]"
            style={{
              gridTemplateColumns: `${isCassette ? '1.4rem' : '1.1rem'} repeat(${colList.length}, 1.6rem)`,
            }}
          >
            {!isCassette && (
              <>
                <span aria-hidden />
                {colList.map((c) => (
                  <span
                    key={`col-${c}`}
                    aria-hidden
                    className="pb-0.5 text-center font-mono text-[9px] leading-none text-text-3"
                  >
                    {c}
                  </span>
                ))}
              </>
            )}

            {rowList.map((r) => (
              <React.Fragment key={`row-${r}`}>
                <span
                  aria-hidden
                  className="flex items-center justify-end pr-1 font-mono text-[9px] text-text-3"
                >
                  {isCassette ? r : rowLabel(r)}
                </span>
                {colList.map((c) => {
                  const pos = `${r}:${c}`;
                  const cell = occupied.get(pos);
                  const key = mode === 'source' ? (cell?.allocation_id ?? pos) : pos;
                  const isSelected = selected.has(key);
                  // A cell claimed by another picker on this same box (a split
                  // output row / a back-flush line) is taken, even though the API
                  // occupancy — committed allocations only — doesn't show it yet.
                  const isReserved = mode === 'destination' && reservedSet.has(pos);
                  // Source takes an occupied position; destination fills a free one.
                  const pickable = mode === 'source' ? Boolean(cell) : !cell && !isReserved;
                  const blocked = disabled || !pickable || (!isSelected && atLimit);
                  const label = positionLabel(r, c, cols);
                  // FIFO cue: tint occupied source cells by expiry urgency so the
                  // oldest stock is the visually obvious pick.
                  const exp = cell ? expiryStatus(cell.expiration_date, nearExpiryDays) : null;
                  const risk = mode === 'source' && exp ? exp.tone : null;

                  const title = cell
                    ? [
                        label,
                        cell.lot_number ?? 'no lot',
                        cell.expiration_date ? `expires ${cell.expiration_date}` : null,
                        mode === 'destination' ? 'occupied' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : isReserved
                      ? `${label} · taken by another placement`
                      : `${label} · empty`;

                  return (
                    <button
                      key={pos}
                      type="button"
                      title={title}
                      aria-label={title}
                      aria-pressed={isSelected}
                      disabled={blocked}
                      onClick={() => toggle(key)}
                      className={cn(
                        'flex h-[1.6rem] w-[1.6rem] items-center justify-center rounded-[5px] border transition-all',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
                        isSelected &&
                          'border-accent bg-accent text-white shadow-sm ring-1 ring-accent/40',
                        !isSelected &&
                          cell &&
                          risk === 'danger' &&
                          'border-danger/40 bg-danger/10 text-danger',
                        !isSelected &&
                          cell &&
                          risk === 'warning' &&
                          'border-warning/45 bg-warning/10 text-warning',
                        !isSelected &&
                          cell &&
                          risk !== 'danger' &&
                          risk !== 'warning' &&
                          'border-border-strong bg-bg-elev text-text-2',
                        !isSelected && !cell && isReserved && 'border-border-strong bg-surface-2 text-text-3',
                        !isSelected && !cell && !isReserved && 'border-dashed border-border bg-transparent',
                        blocked && !isSelected && 'cursor-not-allowed opacity-40',
                        !blocked &&
                          !isSelected &&
                          'hover:border-accent hover:ring-1 hover:ring-accent/30',
                      )}
                    >
                      {isSelected ? (
                        <Check size={11} strokeWidth={3} aria-hidden />
                      ) : cell || isReserved ? (
                        <span aria-hidden className="size-1.5 rounded-full bg-current opacity-70" />
                      ) : null}
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Legend + occupancy summary. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-3">
        <Swatch
          className="border-border-strong bg-bg-elev"
          label={mode === 'source' ? 'available' : 'occupied'}
        />
        {mode === 'source' && <Swatch className="border-warning/45 bg-warning/10" label="near expiry" />}
        {mode === 'source' && <Swatch className="border-danger/40 bg-danger/10" label="expired" />}
        <Swatch className="border-dashed border-border" label="empty" />
        <Swatch className="border-accent bg-accent" label="selected" />
        <span className="ml-auto tabular-nums">
          {occupied.size} occupied · {freeCount} free
        </span>
      </div>

      {chosen.length > 0 && (
        <p className="text-[11px] text-text-3">
          Positions: <span className="font-mono text-text-2">{chosen.join(', ')}</span>
        </p>
      )}
    </div>
  );
}

function Swatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('inline-block size-2.5 rounded-[3px] border', className)} aria-hidden />
      {label}
    </span>
  );
}

// ── Destination boxes: geometry + occupancy straight from the Location System ─

interface BoxGrid {
  rows: number;
  cols: number;
  /** EVERY occupied cell, whatever item is in it. */
  cells: CellOption[];
}

/**
 * Grid geometry and live occupancy for a location node, or `null` when the node
 * is not a box.
 *
 * Deliberately reads the Location System rather than a kit's `source_options`.
 * Source options only describe locations that currently hold *this component*,
 * which is wrong twice over for a return destination:
 *
 *  1. You can return into any box — including one this kit never pulled from,
 *     which has no source-options entry at all, so no grid would render.
 *  2. A cell holding a *different* item still blocks placement
 *     (`uq_lot_allocations_cell`). Occupancy has to be item-agnostic or the
 *     picker offers cells that the API then rejects as `cell_occupied`.
 */
export function useBoxGrid(nodeId: string | null | undefined) {
  const [grid, setGrid] = React.useState<BoxGrid | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!nodeId) {
      setGrid(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const node = await locationNodesApi.get(nodeId, { signal: ctrl.signal });
        if (!node.grid_rows || !node.grid_cols) {
          setGrid(null);
          return;
        }
        const allocs = await locationNodesApi.nodeAllocations(nodeId, { signal: ctrl.signal });
        setGrid({
          rows: node.grid_rows,
          cols: node.grid_cols,
          cells: allocs
            .filter((a) => a.grid_row != null && a.grid_col != null)
            .map((a) => ({
              allocation_id: a.id,
              grid_row: a.grid_row as number,
              grid_col: a.grid_col as number,
              lot_id: a.lot_id,
              lot_number: a.lot_number,
              expiration_date: null,
            })),
        });
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setGrid(null);
      } finally {
        setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [nodeId]);

  return { grid, loading };
}

/**
 * Free-cell picker for a return destination. Renders nothing for a bulk
 * location, so callers can drop it in unconditionally after any location
 * picker. `onResolved` reports whether the node turned out to be a box, so the
 * parent can gate its submit button without duplicating the fetch.
 */
export function BoxCellPicker({
  nodeId,
  qty,
  value,
  onChange,
  onResolved,
  reserved,
  derive = false,
}: {
  nodeId: string | null | undefined;
  /** In exact mode: the number of cells that must be picked. In derive mode:
   *  the CAP (e.g. what's on the floor) — the quantity follows the selection. */
  qty: number;
  value: string[];
  onChange: (next: string[]) => void;
  onResolved?: (isBox: boolean) => void;
  /** `"row:col"` cells claimed by another picker on the SAME box in this form,
   *  blocked here so two placements can't fight over one cell. */
  reserved?: Set<string>;
  /** LN2 return: don't type a quantity — the count follows the cells picked,
   *  exactly like issuing from a box. `qty` becomes the upper cap. */
  derive?: boolean;
}) {
  const { grid, loading } = useBoxGrid(nodeId);
  const isBox = grid !== null;

  React.useEffect(() => {
    if (!loading) onResolved?.(isBox);
  }, [isBox, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!nodeId || loading) {
    return nodeId && loading ? (
      <p className="mt-2 text-xs text-text-3">Checking location…</p>
    ) : null;
  }
  if (!grid) return null;

  return (
    <div className="mt-2">
      <CellGridPicker
        mode="destination"
        rows={grid.rows}
        cols={grid.cols}
        cells={grid.cells}
        value={value}
        onChange={onChange}
        max={qty}
        reserved={reserved}
      />
      {derive
        ? value.length === 0 && (
            <p className="mt-1 text-xs text-text-3">
              Select the cells to fill — the return quantity follows your selection.
            </p>
          )
        : value.length !== qty && (
            <p className="mt-1 text-xs text-danger">
              Pick {qty} free cell{qty === 1 ? '' : 's'} — a cell holds one unit.
            </p>
          )}
    </div>
  );
}
