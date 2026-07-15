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

/**
 * A storage leaf's contents (its active allocations) with a per-allocation
 * Transfer action. Shared by the Warehouse (shelves) and Freezer
 * (sub-locations) pages so stock can be moved out of either area.
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
  const [transferAlloc, setTransferAlloc] = React.useState<Allocation | null>(null);

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
                        {allocs.map((a) => (
                          <TableRow key={a.id}>
                            <TableCell className="font-mono text-text-2">
                              <ItemLink itemNumber={a.item_number} />
                            </TableCell>
                            <TableCell className="font-mono text-text-2">
                              <LotLink lotId={a.lot_id} lotNumber={a.lot_number} />
                              {a.grid_row != null && a.grid_col != null
                                ? ` (${a.grid_row},${a.grid_col})`
                                : ''}
                            </TableCell>
                            <TableCell className="text-right font-mono">{a.qty}</TableCell>
                            {canTransfer && (
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => setTransferAlloc(a)}
                                >
                                  <ArrowLeftRight size={13} /> Transfer
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
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
        open={Boolean(transferAlloc)}
        onOpenChange={(o) => !o && setTransferAlloc(null)}
        allocation={transferAlloc}
        sourceLabel={node?.name}
        onDone={() => {
          setTransferAlloc(null);
          void reload();
          onChanged();
        }}
      />
    </>
  );
}
