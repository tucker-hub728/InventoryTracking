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
  picksTotal,
  pickKey,
  picksToSources,
  picksValid,
  type LotPick,
} from '@/components/reconciliation/lot-source-picker';
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
 *  the source allocation is in hand and step ① is a read-only line. */
interface AllocationProps extends BaseProps {
  allocation: Allocation | null;
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
  allocation?: never;
  sourceLabel?: never;
}

type Props = AllocationProps | ItemProps;

/** Map a stock-location row to the shape the (reused) kitting lot picker wants. */
function toSourceLot(s: ApiItemStockLocation): KitLineSourceLot {
  return {
    lot_id: s.lot_id,
    lot_number: s.lot_number,
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
  const { allocation = null, sourceLabel } = props as AllocationProps;
  const { item = null, presetSource = null } = props as ItemProps;

  // Allocation mode — a single typed quantity capped by the source allocation.
  const maxQty = allocation?.qty ?? 0;
  const [qty, setQty] = React.useState('1');

  // Item mode — the multi-lot source picker.
  const [lots, setLots] = React.useState<KitLineSourceLot[] | null>(null);
  const [picks, setPicks] = React.useState<LotPick[]>([]);
  // Item mode destinations, one per source row, keyed by the row's identity
  // (lot × location) rather than its index — removing a row shifts every index
  // below it, which would silently re-point the wrong destinations. The picker
  // already forbids the same lot × location on two rows, so the key is unique.
  // Re-pointing a row at a different lot drops its destination, which is right:
  // it is a different move now.
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

  /** Cells in ``nodeId`` that rows OTHER than ``key`` have already claimed, as
   *  ``"row:col"`` keys. Two rows may legitimately target the same box; they
   *  may not target the same cell, and the grid should say so while the
   *  operator is choosing rather than at submit. */
  const cellsClaimedByOtherRows = (key: string, nodeId: string | undefined) => {
    const claimed = new Set<string>();
    if (!nodeId) return claimed;
    for (const [k, dest] of Object.entries(destinations)) {
      if (k === key || !dest || dest.nodeId !== nodeId) continue;
      for (const c of dest.cells) claimed.add(`${c.grid_row}:${c.grid_col}`);
    }
    return claimed;
  };

  React.useEffect(() => {
    if (!open) return;
    setQty(String(allocation?.qty ?? 1));
    setLots(null);
    setPicks([]);
    setDestinations({});
    setPlacement(null);
    setShowReauth(false);
    setSubmitting(false);
    setError(null);
  }, [open, allocation, item, presetSource, setError]);

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
      const dest = destinations[pickKey(p.lot_id, p.node_id)] ?? null;
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
          sources: picksToSources(picks).map((s) => {
            const dest = destinations[pickKey(s.lot_id, s.node_id)]!;
            return {
              ...s,
              to_node_id: dest.nodeId,
              to_cells: dest.nodeType === 'box' ? dest.cells : undefined,
            };
          }),
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
      } else if (!placement) {
        return;
      } else if (placement.nodeType === 'box') {
        await locationNodesApi.transferBatch({
          allocation_ids: [allocation!.id],
          to_node_id: placement.nodeId,
          to_cells: placement.cells,
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
      } else {
        await locationNodesApi.transfer({
          allocation_id: allocation!.id,
          to_node_id: placement.nodeId,
          qty: qtyNum,
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
                              value={destinations[pickKey(row.lot_id, row.node_id)] ?? null}
                              onChange={(next) =>
                                editDestination(pickKey(row.lot_id, row.node_id), next)
                              }
                              // Cells the OTHER rows already aim at in this same
                              // box. Nothing on the server knows about them
                              // until the transfer is signed, so without this
                              // two rows can each pick A1 and only find out at
                              // submit.
                              reservedCells={cellsClaimedByOtherRows(
                                pickKey(row.lot_id, row.node_id),
                                destinations[pickKey(row.lot_id, row.node_id)]?.nodeId,
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
                />
              ) : (
                <p className="text-xs text-text-3">Loading locations…</p>
              )}
            </div>

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
        // The record the operator signed ABOUT: an item-workspace transfer may
        // move several lots at once, so the subject is the item itself.
        recordTable={byItem ? 'app.items' : 'app.lot_allocations'}
        recordId={byItem ? item?.uuid : allocation?.id}
        meaning={`I am transferring ${moveQty} unit(s) of ${subject}.`}
        commentPlaceholder="e.g. Moved to freezer for cold storage"
        onConfirmed={submit}
        title="Sign this transfer"
        submitLabel="Sign & transfer"
      />
    </>
  );
}
