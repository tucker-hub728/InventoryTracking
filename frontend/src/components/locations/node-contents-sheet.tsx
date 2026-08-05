'use client';

import * as React from 'react';
import { ArrowLeftRight, PackageOpen } from 'lucide-react';

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ItemLink } from '@/components/inventory/item-link';
import { LotLink } from '@/components/inventory/lot-link';
import { locationNodesApi, type Allocation, type NodeTree } from '@/lib/api/location-nodes';

import { TransferDialog } from './transfer-dialog';

/** One line of a leaf's contents: a lot at this location, and every allocation
 *  row making it up. */
interface ContentRow {
  key: string;
  allocations: Allocation[];
  qty: number;
}

/**
 * Group a leaf's allocations the way the operator sees the shelf.
 *
 * The API returns raw ``lot_allocations`` rows, and a flat shelf collects a new
 * one on every placement and every transfer in — so 61 units of one lot showed
 * up as nine rows of 1, 2, 1, 1, 1, 51, 1, 1, 2. They are the same stock in the
 * same place; nothing distinguishes them but the order they arrived, which is
 * the ledger's business, not this panel's. The item's "Stock by location" tab
 * already sums per (location, lot); this makes the two agree.
 *
 * A BOX is the exception: each allocation is one vial at one cell, so the cell
 * coordinate is real information and the rows stay apart.
 */
function toRows(allocs: Allocation[]): ContentRow[] {
  const rows = new Map<string, ContentRow>();
  for (const a of allocs) {
    const isCell = a.grid_row != null && a.grid_col != null;
    const key = isCell ? a.id : `${a.item_id ?? ''}:${a.lot_id}`;
    const existing = rows.get(key);
    if (existing) {
      existing.allocations.push(a);
      existing.qty += a.qty;
    } else {
      rows.set(key, { key, allocations: [a], qty: a.qty });
    }
  }
  return [...rows.values()];
}

/**
 * A storage leaf's contents with a per-lot Transfer action. Shared by the
 * Warehouse (shelves) and Freezer (sub-locations) pages so stock can be moved
 * out of either area.
 */
export function NodeContentsSheet({
  open,
  onOpenChange,
  node,
  pathLabel,
  badges,
  canTransfer,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: NodeTree | null;
  pathLabel: string;
  badges?: React.ReactNode;
  canTransfer: boolean;
  onChanged: () => void;
}) {
  const [allocs, setAllocs] = React.useState<Allocation[]>([]);
  const [loading, setLoading] = React.useState(false);
  // The allocations behind the row being transferred — a lot's whole holding on
  // a shelf, or a single vial in a box.
  const [transferRow, setTransferRow] = React.useState<Allocation[] | null>(null);

  const reload = React.useCallback(
    async (signal?: AbortSignal) => {
      if (!node) return;
      setLoading(true);
      try {
        setAllocs(await locationNodesApi.nodeAllocations(node.id, { signal }));
      } catch {
        /* empty on error */
      } finally {
        setLoading(false);
      }
    },
    [node],
  );

  React.useEffect(() => {
    if (!open || !node) return;
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [open, node, reload]);

  const onHand = allocs.reduce((sum, a) => sum + a.qty, 0);
  const rows = React.useMemo(() => toRows(allocs), [allocs]);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right">
          {node && (
            <>
              <SheetHeader>
                <SheetTitle>{node.name}</SheetTitle>
                <SheetDescription>{pathLabel}</SheetDescription>
                {badges && <div className="mt-1 flex flex-wrap gap-2">{badges}</div>}
              </SheetHeader>
              <SheetBody className="space-y-4">
                <div className="rounded-md border border-border bg-surface px-3 py-2">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-text-3">
                    On hand
                  </div>
                  <div className="mt-0.5 text-lg font-semibold tracking-tight text-text">
                    {onHand} units
                  </div>
                </div>

                {loading ? (
                  <Skeleton className="h-24 w-full rounded-lg" />
                ) : allocs.length === 0 ? (
                  <EmptyState
                    icon={PackageOpen}
                    title="Nothing placed here yet"
                    hint="Units land here when received in Receipt Admin."
                  />
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Item</TableHead>
                          <TableHead>Lot</TableHead>
                          <TableHead className="w-[70px] text-right">Qty</TableHead>
                          {canTransfer && <TableHead className="w-[110px]" />}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((row) => {
                          const a = row.allocations[0]!;
                          return (
                            <TableRow key={row.key}>
                              <TableCell className="font-mono text-text-2">
                                <ItemLink itemNumber={a.item_number} itemId={a.item_id} />
                              </TableCell>
                              <TableCell className="font-mono text-text-2">
                                <LotLink lotId={a.lot_id} lotNumber={a.lot_number} />
                                {a.grid_row != null && a.grid_col != null
                                  ? ` (${a.grid_row},${a.grid_col})`
                                  : ''}
                              </TableCell>
                              <TableCell className="text-right font-mono">{row.qty}</TableCell>
                              {canTransfer && (
                                <TableCell className="text-right">
                                  <Button
                                    variant="ghost"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => setTransferRow(row.allocations)}
                                  >
                                    <ArrowLeftRight size={13} /> Transfer
                                  </Button>
                                </TableCell>
                              )}
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>

      <TransferDialog
        open={Boolean(transferRow)}
        onOpenChange={(o) => !o && setTransferRow(null)}
        allocations={transferRow}
        sourceLabel={node?.name}
        onDone={() => {
          setTransferRow(null);
          void reload();
          onChanged();
        }}
      />
    </>
  );
}
