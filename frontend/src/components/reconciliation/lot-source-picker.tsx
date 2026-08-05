'use client';

import * as React from 'react';
import { Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SearchableSelect, type SearchableSelectOption } from '@/components/ui/searchable-select';
import { cn } from '@/lib/utils';
import { expiryStatus } from '@/lib/inventory-helpers';
import type { KitLineSourceLot } from '@/lib/api/kits';

import { CellGridPicker } from './cell-grid-picker';
import { LocationTreePicker } from './location-tree-picker';
import { NumberInput } from './recon-bits';

/**
 * Multi-lot issue picker (KIT-002/003), "add next" style with a TWO-STEP row:
 * first pick the shelf/location from the storage hierarchy, then pick the lot
 * held there (with its available qty) and how much to pull. When one lot can't
 * cover the need, "Add another lot" appends the next earliest-expiry lot with
 * the remainder pre-filled (FIFO), exactly as REQ-2026-07-22-KIT-003 describes.
 *
 * A bulk (shelf/freezer) lot takes a quantity; a box lot hands the quantity to
 * the vial (cell) selection (D2) — the operator taps the exact vials.
 */

export interface LotPick {
  lot_id: string;
  node_id: string;
  /** Bulk lots: the quantity to pull. Box lots: mirrors `cells.length`. */
  qty: number;
  /** Box lots only: the exact vial allocation ids picked. */
  cells: string[];
  is_grid: boolean;
}

/** A lot is identified by (lot, location) — the same lot can sit on two shelves. */
export const pickKey = (lotId: string, nodeId: string) => `${lotId}:${nodeId}`;

/** Effective quantity of a pick — cell count for a box, else the typed qty. */
const pickQty = (p: LotPick) => (p.is_grid ? p.cells.length : p.qty);

/** Total across all filled picks — what will actually be issued for the line. */
export const picksTotal = (picks: LotPick[]) =>
  picks.reduce((a, p) => a + (p.lot_id ? pickQty(p) : 0), 0);

/** No pick pulls more of a lot than physically exists — the only hard rule at
 *  issue under KIT-007 (no recipe gating; a short or zero pick is fine, it's
 *  simply ignored). A row with no lot, or a zero quantity, is not "invalid" —
 *  it just doesn't post.
 *
 *  Quantities are summed PER (lot × location), not checked row by row: when a
 *  caller allows one source on several rows (the transfer dialog splits a lot
 *  across destinations), two rows of 4 and 3 against a lot of 5 are each
 *  individually fine and together impossible. */
export function picksValid(lots: KitLineSourceLot[], picks: LotPick[]): boolean {
  const drawn = new Map<string, number>();
  for (const p of picks) {
    if (!p.lot_id) continue; // an empty / location-only row is ignored
    const key = pickKey(p.lot_id, p.node_id);
    drawn.set(key, (drawn.get(key) ?? 0) + pickQty(p));
  }
  for (const [key, qty] of drawn) {
    const lot = lots.find((x) => pickKey(x.lot_id, x.node_id) === key);
    if (!lot || qty > lot.qty) return false; // physical cap only
  }
  return true;
}

const lotByKey = (lots: KitLineSourceLot[], key: string) =>
  lots.find((l) => pickKey(l.lot_id, l.node_id) === key);

/** The next earliest-expiry lot not already used, with `remaining` pre-filled
 *  (a box lot starts at 0 — the operator picks vials). Null when none is left. */
function nextRow(lots: KitLineSourceLot[], used: Set<string>, remaining: number): LotPick | null {
  const lot = lots.find((l) => l.qty > 0 && !used.has(pickKey(l.lot_id, l.node_id)));
  if (!lot) return null;
  return {
    lot_id: lot.lot_id,
    node_id: lot.node_id,
    is_grid: lot.is_grid,
    cells: [],
    qty: lot.is_grid ? 0 : Math.min(Math.max(remaining, 1), lot.qty),
  };
}

/**
 * FIFO auto-fill across the **bulk** lots to cover `needed`, honouring any box
 * vials already picked. Box lots are skipped — their quantity follows a manual
 * vial selection. Used to pre-fill the picker so it opens already covering the
 * need (KIT-002); the operator then tweaks rows or adds more. Lots arrive
 * FIFO-ordered from the backend.
 */
export function autoFillFifo(
  lots: KitLineSourceLot[],
  needed: number,
  keep: LotPick[] = [],
): LotPick[] {
  const boxPicks = keep.filter((p) => p.is_grid && p.cells.length > 0);
  let remaining = Math.max(0, needed - picksTotal(boxPicks));
  const bulk: LotPick[] = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    if (lot.is_grid) continue; // box lots need manual vial picks
    const take = Math.min(remaining, lot.qty);
    if (take <= 0) continue;
    bulk.push({ lot_id: lot.lot_id, node_id: lot.node_id, qty: take, cells: [], is_grid: false });
    remaining -= take;
  }
  const rows = [...boxPicks, ...bulk];
  // Never render empty: if nothing pre-filled but stock exists, seed one blank
  // row so the operator has a location dropdown to start from.
  if (rows.length === 0 && lots.length > 0) {
    rows.push({ lot_id: '', node_id: '', qty: 0, cells: [], is_grid: false });
  }
  return rows;
}

/** Convert picks to the API `sources` shape, dropping empty / zero rows. */
export function picksToSources(picks: LotPick[]) {
  return picks
    .filter((p) => p.lot_id && (p.is_grid ? p.cells.length > 0 : p.qty > 0))
    .map((p) => ({
      node_id: p.node_id,
      lot_id: p.lot_id,
      qty: pickQty(p),
      cell_allocation_ids: p.is_grid ? p.cells : undefined,
    }));
}

/** One lot dropdown option (within an already-chosen shelf) — lot #, expiry,
 *  and how much of it is on that shelf. */
function lotOption(lot: KitLineSourceLot): SearchableSelectOption {
  const exp = expiryStatus(lot.expiration_date, 30);
  return {
    value: pickKey(lot.lot_id, lot.node_id),
    searchText: `${lot.lot_number ?? ''} ${lot.expiration_date ?? ''}`,
    label: (
      <span className="flex w-full items-center gap-2">
        <span className="shrink-0 font-mono text-xs text-text">{lot.lot_number ?? 'No lot'}</span>
        {lot.expiration_date && (
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[11px]',
              exp?.tone === 'danger'
                ? 'text-danger'
                : exp?.tone === 'warning'
                  ? 'text-warning'
                  : 'text-text-3',
            )}
          >
            exp {lot.expiration_date}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-text-2">
          {lot.qty} avail
        </span>
      </span>
    ),
  };
}

export function LotSourcePicker({
  itemNumber,
  lots,
  needed,
  picks,
  onChange,
  disabled = false,
  modal = false,
  renderRowFooter,
  addLabel = 'Add another lot',
  allowDuplicateLots = false,
}: {
  itemNumber: string;
  lots: KitLineSourceLot[];
  /** The quantity to reach — the BOM need (issue) or the entered extra (more). */
  needed: number;
  picks: LotPick[];
  onChange: (picks: LotPick[]) => void;
  disabled?: boolean;
  /** Pass true when the picker lives inside a Dialog/Sheet (scroll-lock). */
  modal?: boolean;
  /** Extra content rendered inside each row, below its cell grid. The transfer
   *  dialog uses it to hang a per-row DESTINATION off each source, since a
   *  transfer states where every lot goes rather than sharing one target
   *  (client 2026-08-05). Omitted everywhere else, which leaves the kitting
   *  Issue and ship-to-customer rows exactly as they were. */
  renderRowFooter?: (index: number, pick: LotPick) => React.ReactNode;
  /** Wording of the add button — "lot" reads wrong when each row is a whole
   *  from-and-to leg rather than just another lot to draw from. */
  addLabel?: string;
  /**
   * Let one lot × location appear on SEVERAL rows. Off by default: for a kit
   * issue or a shipment two rows of the same lot are just one row with a bigger
   * number, so offering it only invites a mistake.
   *
   * The transfer dialog turns it on, because there each row carries its own
   * destination — splitting 5 units into 4 here and 1 there is the only way to
   * empty a shelf into a box that has 4 free cells left. ``picksValid`` sums per
   * lot, so the split still cannot exceed what is physically there.
   */
  allowDuplicateLots?: boolean;
}) {
  const total = picksTotal(picks);
  const remaining = Math.max(0, needed - total);
  const short = total < needed;

  const setRow = (i: number, next: LotPick | null) => {
    if (disabled) return;
    const rows = picks.slice();
    if (next === null) rows.splice(i, 1);
    else rows[i] = next;
    onChange(rows);
  };

  // Keys used by every OTHER row, so a lot can't be picked twice — unless the
  // caller allows a lot to be split across rows, in which case nothing is
  // excluded and the per-lot cap in ``picksValid`` is what holds the line.
  const usedBy = (skip: number) =>
    allowDuplicateLots
      ? new Set<string>()
      : new Set(
          picks
            .map((p, j) => (j !== skip && p.lot_id ? pickKey(p.lot_id, p.node_id) : ''))
            .filter(Boolean),
        );

  const fillRow = (i: number, lot: KitLineSourceLot) => {
    // Default the quantity to whatever is still needed (capped at the lot).
    const otherTotal = total - (picks[i]?.lot_id ? pickQty(picks[i]) : 0);
    const want = Math.max(0, needed - otherTotal);
    setRow(i, {
      lot_id: lot.lot_id,
      node_id: lot.node_id,
      is_grid: lot.is_grid,
      cells: [],
      qty: lot.is_grid ? 0 : Math.min(Math.max(want, 1), lot.qty),
    });
  };

  const chooseNode = (i: number, nodeId: string) => {
    const others = usedBy(i);
    const here = lots.filter((l) => l.node_id === nodeId && !others.has(pickKey(l.lot_id, l.node_id)));
    // A shelf with exactly one lot needs no second choice — pick it straight away.
    if (here.length === 1 && here[0]) {
      fillRow(i, here[0]);
      return;
    }
    setRow(i, { lot_id: '', node_id: nodeId, qty: 0, cells: [], is_grid: false });
  };

  const chooseLot = (i: number, key: string) => {
    const lot = lotByKey(lots, key);
    if (lot) fillRow(i, lot);
  };

  const addRow = () => {
    const row = nextRow(lots, usedBy(-1), remaining);
    onChange([...picks, row ?? { lot_id: '', node_id: '', qty: 0, cells: [], is_grid: false }]);
  };

  if (lots.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-surface/50 px-3 py-2 text-xs text-text-3">
        {itemNumber} isn&apos;t in stock at any location.
      </p>
    );
  }

  // How much of each lot × location the rows already draw, so both the add
  // button and the per-row error can reason about a lot split over several rows.
  const drawnPerLot = new Map<string, number>();
  for (const p of picks) {
    if (!p.lot_id) continue;
    const k = pickKey(p.lot_id, p.node_id);
    drawnPerLot.set(k, (drawnPerLot.get(k) ?? 0) + pickQty(p));
  }
  const allUsed = new Set(drawnPerLot.keys());
  const anyLeft = allowDuplicateLots
    ? // A lot can be picked again while any of it is still undrawn.
      lots.some((l) => l.qty > (drawnPerLot.get(pickKey(l.lot_id, l.node_id)) ?? 0))
    : lots.some((l) => l.qty > 0 && !allUsed.has(pickKey(l.lot_id, l.node_id)));
  const pct = needed > 0 ? Math.min(100, Math.round((total / needed) * 100)) : total > 0 ? 100 : 0;

  return (
    <div className="rounded-lg border border-border bg-bg-elev/40 p-2.5">
      {/* Column headers — clarify the two steps and align every row below. */}
      <div className="mb-1.5 flex items-center gap-2 pl-6 pr-8 text-[10px] font-medium uppercase tracking-wider text-text-3">
        <span className="min-w-0 flex-[2]">Location</span>
        <span className="min-w-0 flex-[3]">Lot</span>
        <span className="w-28 shrink-0 pr-1 text-right">Issue</span>
      </div>

      <div className="space-y-1.5">
        {picks.map((row, i) => {
          const others = usedBy(i);
          // Shelves that still have an unused lot (plus this row's current shelf).
          const nodeIds = new Set<string>();
          const nodeQty: Record<string, number> = {};
          for (const l of lots) {
            if (others.has(pickKey(l.lot_id, l.node_id))) continue;
            nodeIds.add(l.node_id);
            nodeQty[l.node_id] = (nodeQty[l.node_id] ?? 0) + l.qty;
          }
          if (row.node_id) nodeIds.add(row.node_id);

          const lotKey = row.lot_id ? pickKey(row.lot_id, row.node_id) : '';
          const lot = lotKey ? lotByKey(lots, lotKey) : undefined;
          // Lots on the chosen shelf, minus ones used elsewhere, plus this pick.
          const lotOptions = lots
            .filter(
              (l) =>
                l.node_id === row.node_id &&
                (pickKey(l.lot_id, l.node_id) === lotKey ||
                  !others.has(pickKey(l.lot_id, l.node_id))),
            )
            .map(lotOption);

          const taken = pickQty(row);
          // Measured against the WHOLE draw on this lot, so splitting it over
          // two rows can't quietly take more than the lot holds.
          const drawnHere = lot ? (drawnPerLot.get(lotKey) ?? taken) : taken;
          const over = lot ? drawnHere > lot.qty : false;
          const emptyQty = Boolean(lot) && !lot?.is_grid && taken === 0;
          const rowError = over || emptyQty || (Boolean(lot?.is_grid) && taken === 0);

          return (
            <div
              key={i}
              className={cn(
                'rounded-md border bg-surface/30 px-2 py-1.5 transition-colors',
                rowError ? 'border-danger/40' : 'border-transparent',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-text-3">
                  {i + 1}
                </span>
                {/* Step 1 — the shelf, from the storage hierarchy. */}
                <div className="min-w-0 flex-[2]">
                  <LocationTreePicker
                    aria-label={`Location ${i + 1} for ${itemNumber}`}
                    value={row.node_id}
                    onChange={(nodeId) => chooseNode(i, nodeId)}
                    allowedNodeIds={nodeIds}
                    nodeQty={nodeQty}
                    selectable={() => true}
                    showPath
                    modal={modal}
                    disabled={disabled}
                    placeholder="Choose a shelf…"
                    emptyText="This item isn't stocked anywhere else."
                  />
                </div>
                {/* Step 2 — the lot on that shelf. */}
                <div className="min-w-0 flex-[3]">
                  <SearchableSelect
                    aria-label={`Lot ${i + 1} for ${itemNumber}`}
                    options={lotOptions}
                    value={lotKey}
                    onChange={(v) => chooseLot(i, v)}
                    disabled={disabled || !row.node_id || lotOptions.length === 0}
                    modal={modal}
                    placeholder={
                      !row.node_id
                        ? 'Pick a shelf first'
                        : lotOptions.length
                          ? 'Choose a lot'
                          : 'No lots here'
                    }
                    searchPlaceholder="Search lot / expiry…"
                    emptyText="No lots here."
                  />
                </div>
                {/* How much to pull — quantity (bulk) or vial count (box). */}
                <div className="flex w-28 shrink-0 items-center justify-end gap-1.5">
                  {lot?.is_grid ? (
                    <span className="font-mono text-xs tabular-nums text-text-2">
                      {taken}
                      <span className="text-[10px] text-text-3"> vial{taken === 1 ? '' : 's'}</span>
                    </span>
                  ) : (
                    <>
                      <NumberInput
                        aria-label={`Quantity from lot ${lot?.lot_number ?? ''}`}
                        value={taken || null}
                        min={0}
                        invalid={over || emptyQty}
                        disabled={disabled || !lot}
                        onChange={(v) => setRow(i, { ...row, qty: v ?? 0 })}
                        className="h-7 w-16 px-2"
                      />
                      <span className="w-10 shrink-0 text-[11px] tabular-nums text-text-3">
                        {lot ? `/${lot.qty}` : ''}
                      </span>
                    </>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove this row"
                  disabled={disabled}
                  onClick={() => setRow(i, null)}
                  className="shrink-0 text-text-3 hover:text-danger"
                >
                  <X size={14} />
                </Button>
              </div>

              {rowError && (
                <p className="mt-1 pl-6 text-[11px] text-danger">
                  {over
                    ? drawnHere > taken
                      ? `Only ${lot?.qty} available in this lot, and the rows together take ${drawnHere}.`
                      : `Only ${lot?.qty} available in this lot.`
                    : lot?.is_grid
                      ? 'Pick the vials below.'
                      : 'Enter a quantity.'}
                </p>
              )}

              {lot?.is_grid && (
                <div className="mt-2 pl-6">
                  <CellGridPicker
                    mode="source"
                    rows={lot.grid_rows ?? 1}
                    cols={lot.grid_cols ?? 1}
                    cells={lot.cells}
                    value={row.cells}
                    max={lot.qty}
                    disabled={disabled}
                    onChange={(cells) => setRow(i, { ...row, cells, qty: cells.length })}
                  />
                </div>
              )}

              {renderRowFooter && (
                <div className="mt-2 pl-6">{renderRowFooter(i, row)}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer — add another lot + a progress meter toward the need. */}
      <div className="mt-2.5 flex items-center gap-3 border-t border-border/70 pt-2.5">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || !anyLeft}
          onClick={addRow}
          title={anyLeft ? 'Draw the remainder from another lot' : 'No other lots hold this item'}
        >
          <Plus size={13} /> {addLabel}
        </Button>
        {needed > 0 ? (
          <div className="flex flex-1 items-center gap-2">
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-border"
              role="progressbar"
              aria-valuenow={total}
              aria-valuemax={needed}
            >
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  short ? 'bg-accent' : 'bg-success',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span
              className={cn(
                'shrink-0 font-mono text-xs tabular-nums',
                short ? 'text-text-2' : 'text-success',
              )}
            >
              {total} / {needed}
            </span>
          </div>
        ) : (
          // No fixed target (e.g. issue-more): just show what's been picked.
          <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-success">
            {total} selected
          </span>
        )}
      </div>
    </div>
  );
}
