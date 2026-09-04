'use client';

import * as React from 'react';
import { ArrowLeftRight } from 'lucide-react';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import {
  LotSourcePicker,
  autoFillFifo,
  filledPicks,
  newPickRid,
  pickToSource,
  picksTotal,
  picksValid,
  type LotPick,
} from '@/components/reconciliation/lot-source-picker';
import { RejectedLotWarning } from '@/components/inventory/rejected-lot-warning';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import type { KitLineSourceLot } from '@/lib/api/kits';
import { itemsApi, type ApiItemStockLocation } from '@/lib/api/items';
import { locationNodesApi, type Allocation } from '@/lib/api/location-nodes';
import { cn } from '@/lib/utils';
import {
  ReceiveLocationPicker,
  placementComplete,
  type AreaTrees,
  type PlacementValue,
} from '@/components/inventory/receipt-admin/receive-location-picker';

interface BaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

/** Location-view entry: the operator is already standing in a shelf / box, so
 *  the source is in hand and step ① is a read-only quantity.
 *
 *  An array, because one lot on a shelf is usually several allocation rows —
 *  a shelf collects one per placement and per transfer in. The panel shows
 *  them as the single holding they are, so a transfer has to be able to draw
 *  across all of them. A box cell is a one-element array. */
interface AllocationProps extends BaseProps {
  allocations: Allocation[] | null;
  /** Human label for the source location (breadcrumb). */
  sourceLabel?: string;
  item?: never;
  presetSource?: never;
}

/** Inventory-workspace entry (REQ-2026-07-15-TRX-001, refined 2026-07-22): the
 *  operator opened an item, so the dialog asks *where from* first — across as
 *  many lots / locations as the item is spread over. */
interface ItemProps extends BaseProps {
  item: { uuid: string; id: string; desc: string } | null;
  /** A (lot × location) to pre-select — the "Stock by location" row action. */
  presetSource?: { lot_id: string; node_id: string } | null;
  allocations?: never;
  sourceLabel?: never;
}

type Props = AllocationProps | ItemProps;

/** Map a stock-location row to the shape the (reused) kitting lot picker wants. */
function toSourceLot(s: ApiItemStockLocation): KitLineSourceLot {
  return {
    lot_id: s.lot_id,
    lot_number: s.lot_number,
    release_state: s.release_state,
    expiration_date: s.expiration_date,
    node_id: s.node_id,
    node_name: s.location,
    path: s.location,
    qty: s.qty,
    is_grid: s.is_grid,
    grid_rows: s.grid_rows,
    grid_cols: s.grid_cols,
    cells: s.cells,
  };
}

/**
 * Move units to another storage leaf, anywhere across the areas
 * (LN2 ↔ Cold Storage ↔ Warehouse). E-signed (action ``movement.transfer``).
 *
 * One dialog, two entry points — REQ-2026-07-22 requires the item workspace to
 * open "the same transfer" the location view does:
 *
 * * **From a location** (``allocation``) — one allocation, partial quantity,
 *   posting through ``/allocations/transfer`` (or ``/transfer-batch`` for a box
 *   destination). Unchanged behaviour.
 * * **From an item** (``item``) — the operator picks the sources here, so the
 *   move may span several lots / locations and posts through
 *   ``/allocations/transfer-multi``, signed once.
 */
export function TransferDialog(props: Props) {
  const { open, onOpenChange, onDone } = props;
  const byItem = props.item !== undefined;
  const { allocations = null, sourceLabel } = props as AllocationProps;
  const { item = null, presetSource = null } = props as ItemProps;

  // Allocation mode — one typed quantity, capped by everything the row holds.
  // ``allocation`` is the representative row (they all share item + lot + node).
  const allocation = allocations?.[0] ?? null;
  const maxQty = (allocations ?? []).reduce((sum, a) => sum + a.qty, 0);
  const [qty, setQty] = React.useState('1');

  // Item mode — the multi-lot source picker.
  const [lots, setLots] = React.useState<KitLineSourceLot[] | null>(null);
  const [picks, setPicks] = React.useState<LotPick[]>([]);
  // Item mode destinations, one per source row, keyed by the ROW's ``rid``.
  //
  // Not by index — removing a row shifts every index below it, which would
  // silently re-point the wrong destinations. And not by (lot × location),
  // which this dialog cannot use as a row identity at all: it passes
  // ``allowDuplicateLots``, so splitting one lot across two destinations puts
  // the same lot × location on two rows on purpose. Keyed that way both rows
  // read and write ONE entry — row 2 opens showing row 1's destination, editing
  // either moves both, and the transfer posts both legs to the same place
  // (client 2026-08-17).
  const [destinations, setDestinations] = React.useState<
    Record<string, PlacementValue | null>
  >({});

  // Allocation mode only — the one destination for the one source allocation.
  const [placement, setPlacement] = React.useState<PlacementValue | null>(null);
  const [trees, setTrees] = React.useState<AreaTrees | null>(null);
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setErrorText] = React.useState<string | null>(null);

  // Bumped every time a message is *raised*, even the same one twice — the
  // scroll below keys on this rather than on the text, so re-submitting an
  // unchanged form still brings the (identical) message back into view.
  const [errorSeq, setErrorSeq] = React.useState(0);
  const errorRef = React.useRef<HTMLParagraphElement>(null);
  const setError = React.useCallback((message: string | null) => {
    setErrorText(message);
    if (message) setErrorSeq((n) => n + 1);
  }, []);

  // The body scrolls (``max-h-[70vh]``) and the message sits at its foot, so on
  // a tall form — a multi-lot source list, or an LN2 grid — it is raised out of
  // sight and the dialog looks like it simply ignored the click.
  //
  // Deferred a frame: the message can mount in the same commit as a destination
  // cell grid, and scrolling before that grid has been laid out aims at a
  // position the element is about to leave.
  React.useEffect(() => {
    if (!errorSeq) return;
    const frame = requestAnimationFrame(() => {
      errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [errorSeq]);

  // Any edit makes the standing message stale: it was about the input the
  // operator has just replaced. Most visibly when swapping an LN2 box
  // destination for a shelf, where "select exactly N cells" no longer applies
  // to anything on screen.
  const editQty = (value: string) => {
    setQty(value);
    setError(null);
  };
  const editPicks = (next: LotPick[]) => {
    setPicks(next);
    // Forget the destination of any row that is gone. It is off screen, but
    // ``cellsClaimedByOtherRows`` still reads the map — a removed row would go
    // on reserving cells in a box nothing is aimed at any more.
    setDestinations((d) => {
      const live = new Set(next.map((p) => p.rid));
      const kept = Object.entries(d).filter(([rid]) => live.has(rid));
      return kept.length === Object.keys(d).length ? d : Object.fromEntries(kept);
    });
    setError(null);
  };
  const editPlacement = (next: PlacementValue | null) => {
    setPlacement(next);
    setError(null);
  };
  const editDestination = (key: string, next: PlacementValue | null) => {
    setDestinations((d) => ({ ...d, [key]: next }));
    setError(null);
  };

  /** Cells in ``nodeId`` that rows OTHER than ``rid`` have already claimed, as
   *  ``"row:col"`` keys. Two rows may legitimately target the same box; they
   *  may not target the same cell, and the grid should say so while the
   *  operator is choosing rather than at submit. */
  const cellsClaimedByOtherRows = (rid: string, nodeId: string | undefined) => {
    const claimed = new Set<string>();
    if (!nodeId) return claimed;
    for (const [k, dest] of Object.entries(destinations)) {
      if (k === rid || !dest || dest.nodeId !== nodeId) continue;
      for (const c of dest.cells) claimed.add(`${c.grid_row}:${c.grid_col}`);
    }
    return claimed;
  };

  React.useEffect(() => {
    if (!open) return;
    setQty(String((allocations ?? []).reduce((sum, a) => sum + a.qty, 0) || 1));
    setLots(null);
    setPicks([]);
    setDestinations({});
    setPlacement(null);
    setShowReauth(false);
    setSubmitting(false);
    setError(null);
  }, [open, allocations, item, presetSource, setError]);

  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    Promise.all([
      locationNodesApi.ln2Tree({ signal: ctrl.signal }),
      locationNodesApi.freezerTree({ signal: ctrl.signal }),
      locationNodesApi.warehouseTree({ signal: ctrl.signal }),
    ])
      .then(([ln2, freezer, warehouse]) =>
        setTrees({ ln2, freezer, warehouse }),
      )
      .catch(() => {});
    return () => ctrl.abort();
  }, [open]);

  // Item mode: where the item is stocked right now, FIFO-ordered.
  React.useEffect(() => {
    if (!open || !byItem || !item) return;
    const ctrl = new AbortController();
    itemsApi
      .stockLocations(item.uuid, { signal: ctrl.signal })
      .then((rows) => {
        const mapped = rows.map(toSourceLot);
        setLots(mapped);
        // A row action names its source, so open with that lot filled in at its
        // full quantity — the same default the location-view transfer uses.
        // Otherwise seed one blank row: there is no target quantity to reach,
        // the operator decides how much moves.
        const preset = presetSource
          ? mapped.find(
              (l) => l.lot_id === presetSource.lot_id && l.node_id === presetSource.node_id,
            )
          : undefined;
        setPicks(
          preset
            ? [
                {
                  rid: newPickRid(),
                  lot_id: preset.lot_id,
                  node_id: preset.node_id,
                  is_grid: preset.is_grid,
                  cells: [],
                  qty: preset.is_grid ? 0 : preset.qty,
                },
              ]
            : autoFillFifo(mapped, 0),
        );
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError('Failed to load this item’s stock.');
      });
    return () => ctrl.abort();
  }, [open, byItem, item, presetSource, setError]);

  const qtyNum = Number(qty);
  const qtyValid = Number.isInteger(qtyNum) && qtyNum >= 1 && qtyNum <= maxQty;
  const pickedTotal = picksTotal(picks);
  // Units the destination must accommodate — a box needs exactly this many cells.
  const moveQty = byItem ? pickedTotal : qtyValid ? qtyNum : 0;
  const noStock = byItem && lots !== null && lots.length === 0;

  const validate = (): string | null => {
    if (!byItem) {
      if (!allocation) return 'No source allocation.';
      if (!qtyValid) return `Quantity must be between 1 and ${maxQty}.`;
      if (!placementComplete(placement, moveQty)) {
        return placement?.nodeType === 'box'
          ? `Select exactly ${moveQty} cell(s) in the destination box.`
          : 'Choose a destination location.';
      }
      if (placement!.nodeId === allocation.location_node_id) {
        return 'Choose a destination different from the source.';
      }
      return null;
    }

    if (!item) return 'No item selected.';
    if (lots === null) return 'Still loading this item’s stock.';
    if (pickedTotal < 1) return 'Choose at least one lot to move.';
    if (!picksValid(lots, picks)) {
      return 'One of the rows takes more than that lot holds.';
    }

    // Each row states its own destination, so each is checked against its own
    // quantity — and the messages name the row, since with several rows on
    // screen "choose a destination" alone doesn't say which one is missing it.
    const rows = picks.filter((p) => p.lot_id);
    const takenCells = new Set<string>();
    for (const [i, p] of rows.entries()) {
      const rowQty = p.is_grid ? p.cells.length : p.qty;
      const dest = destinations[p.rid] ?? null;
      if (!placementComplete(dest, rowQty)) {
        return dest?.nodeType === 'box'
          ? `Row ${i + 1}: select exactly ${rowQty} cell(s) in the destination box.`
          : `Row ${i + 1}: choose a destination location.`;
      }
      if (dest!.nodeId === p.node_id) {
        return `Row ${i + 1}: the destination is the location it is already in.`;
      }
      // Two rows may legitimately target the same box — but not the same cell.
      for (const c of dest!.cells) {
        const key = `${dest!.nodeId}:${c.grid_row}:${c.grid_col}`;
        if (takenCells.has(key)) {
          return `Row ${i + 1}: that destination cell is already taken by another row.`;
        }
        takenCells.add(key);
      }
    }
    return null;
  };

  const openSign = () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setShowReauth(true);
  };

  const submit = async (evidence: ReauthResponse) => {
    setSubmitting(true);
    setError(null);
    try {
      if (byItem) {
        // Each source carries its own destination — validate() has already
        // proved every picked row has a complete one.
        await locationNodesApi.transferMulti({
          // Walked as ROWS rather than as posted sources: two rows can carry the
          // same lot from the same shelf to different places, so a source alone
          // no longer says which destination is its own — only the row does.
          sources: filledPicks(picks).map((p) => {
            const dest = destinations[p.rid]!;
            return {
              ...pickToSource(p),
              to_node_id: dest.nodeId,
              to_cells: dest.nodeType === 'box' ? dest.cells : undefined,
            };
          }),
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
      } else if (!placement || !allocations?.length) {
        return;
      } else {
        // ``transferBatch`` for both destinations: the row may be several
        // allocation rows of one lot, and the batch endpoint is the one that
        // takes them together (it requires a single lot at a single node, which
        // is exactly what a row is). The single-allocation ``transfer`` can't
        // express "take 12 from these four rows".
        const allocation_ids = allocations.map((a) => a.id);
        await locationNodesApi.transferBatch({
          allocation_ids,
          to_node_id: placement.nodeId,
          ...(placement.nodeType === 'box'
            ? { to_cells: placement.cells }
            : { qty: qtyNum }),
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
      }
      toast.success('Transfer recorded', {
        description: `${moveQty} unit${moveQty === 1 ? '' : 's'} moved`,
      });
      onDone();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          setError('Your signature expired or was already used. Sign again.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Failed to record the transfer. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Rejected batches among what is actually being moved (STS-003, client
   * 2026-08-17). A warning only — Product Development routinely consumes
   * rejects, so nothing here gates the submit button.
   *
   * Item mode reads the picked rows; location mode reads the allocation the
   * operator is standing on, which carries the state denormalised.
   */
  const rejectedLots = React.useMemo(() => {
    const names = new Set<string>();
    if (byItem) {
      for (const p of picks) {
        if (!p.lot_id) continue;
        const src = lots?.find((l) => l.lot_id === p.lot_id && l.node_id === p.node_id);
        if (src?.release_state === 'rejected') names.add(src.lot_number ?? p.lot_id.slice(0, 8));
      }
    } else if (allocation?.release_state === 'rejected') {
      names.add(allocation.lot_number ?? allocation.lot_id.slice(0, 8));
    }
    return [...names];
  }, [byItem, picks, lots, allocation]);

  const subject = byItem
    ? item?.id ?? 'this item'
    : allocation?.lot_number ?? 'this lot';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* The source picker needs room for a location column, a lot column and
            an LN2 grid; the single-allocation form does not. */}
        <DialogContent className={cn(byItem ? 'max-w-2xl' : 'max-w-lg')}>
          <DialogHeader>
            <DialogTitle>Transfer stock</DialogTitle>
            <DialogDescription>
              {byItem ? (
                <>
                  Move <span className="font-mono">{item?.id}</span>
                  {item?.desc ? ` — ${item.desc}` : ''} to another location.
                </>
              ) : (
                <>
                  Move units of{' '}
                  <span className="font-mono">{allocation?.lot_number ?? 'this lot'}</span>
                  {sourceLabel ? ` from ${sourceLabel}` : ''} to another location.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {byItem ? (
              <div className="space-y-1.5">
                <Label>What to move, and where</Label>
                {lots === null ? (
                  <p className="text-xs text-text-3">Loading this item’s stock…</p>
                ) : (
                  <LotSourcePicker
                    itemNumber={item?.id ?? ''}
                    lots={lots}
                    // No target to reach — the operator decides how much moves.
                    needed={0}
                    picks={picks}
                    onChange={editPicks}
                    modal
                    addLabel="Add another move"
                    // One shelf's stock may have to land in two places — a box
                    // with 4 free cells can't take 5 units — so the same lot is
                    // allowed on several rows, each with its own destination.
                    // ``picksValid`` sums per lot, so the split still can't
                    // exceed what is physically there.
                    allowDuplicateLots
                    // Every row states its OWN destination, so one signature can
                    // send 10 vials off a shelf into a box and 5 off another
                    // shelf somewhere else (client 2026-08-05).
                    renderRowFooter={(i, row) =>
                      row.lot_id ? (
                        <div className="space-y-1.5 rounded-md border border-border/70 bg-surface/40 p-2">
                          <p className="text-[10px] font-medium uppercase tracking-wider text-text-3">
                            Move row {i + 1} to
                          </p>
                          {trees ? (
                            <ReceiveLocationPicker
                              qty={row.is_grid ? row.cells.length : row.qty}
                              trees={trees}
                              value={destinations[row.rid] ?? null}
                              onChange={(next) => editDestination(row.rid, next)}
                              // A row can't move stock back into the shelf /
                              // box it is drawn from, so that location is
                              // greyed in THIS row's tree rather than accepted
                              // and rejected at signing.
                              excludeNodeId={row.node_id}
                              excludeLabel={
                                lots?.find((l) => l.node_id === row.node_id)?.node_name
                              }
                              // Cells the OTHER rows already aim at in this same
                              // box. Nothing on the server knows about them
                              // until the transfer is signed, so without this
                              // two rows can each pick A1 and only find out at
                              // submit.
                              reservedCells={cellsClaimedByOtherRows(
                                row.rid,
                                destinations[row.rid]?.nodeId,
                              )}
                            />
                          ) : (
                            <p className="text-xs text-text-3">Loading locations…</p>
                          )}
                        </div>
                      ) : (
                        <p className="text-[11px] text-text-3">
                          Pick a lot above, then choose where it goes.
                        </p>
                      )
                    }
                  />
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="tx-qty">Units to move</Label>
                  <Input
                    id="tx-qty"
                    type="number"
                    min={1}
                    max={maxQty}
                    step={1}
                    className="font-mono"
                    value={qty}
                    onChange={(e) => editQty(e.target.value)}
                  />
                  <p className="text-xs text-text-3">{maxQty} available here.</p>
                </div>
              </div>
            )}

            {/* One source allocation, so one destination. In item mode the
                destination lives on each row instead. */}
            <div className={cn('space-y-1.5', byItem && 'hidden')}>
              <Label>Destination</Label>
              {trees ? (
                <ReceiveLocationPicker
                  qty={moveQty}
                  trees={trees}
                  value={placement}
                  onChange={editPlacement}
                  // Same rule from the location view: the operator is standing
                  // in the source, which is the one place this cannot go.
                  excludeNodeId={allocation?.location_node_id}
                  excludeLabel={sourceLabel}
                />
              ) : (
                <p className="text-xs text-text-3">Loading locations…</p>
              )}
            </div>

            <RejectedLotWarning lotNumbers={rejectedLots} action="transfer it" />

            {error && (
              <p
                ref={errorRef}
                role="alert"
                className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
              >
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={openSign}
              disabled={submitting || noStock}
            >
              <ArrowLeftRight size={14} /> Sign &amp; transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action="movement.transfer"
        // The record the operator signed ABOUT, which must match what the
        // endpoint binds the signature to or it is rejected as "made for a
        // different record":
        //
        //   item mode      → /transfer-multi → app.items (several lots at once)
        //   location mode  → /transfer-batch → app.lots  (one lot, N allocations)
        //
        // NOT the allocation. A row here is a lot's whole holding on a shelf —
        // usually several allocation rows — so no single allocation id could
        // stand for what is being signed.
        recordTable={byItem ? 'app.items' : 'app.lots'}
        recordId={byItem ? item?.uuid : allocation?.lot_id}
        meaning={`I am transferring ${moveQty} unit(s) of ${subject}.`}
        commentPlaceholder="e.g. Moved to freezer for cold storage"
        onConfirmed={submit}
        title="Sign this transfer"
        submitLabel="Sign & transfer"
      />
    </>
  );
}
