'use client';

import * as React from 'react';
import { ArrowRightLeft, Minus, PackagePlus } from 'lucide-react';

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { lotsApi, type Lot } from '@/lib/api/lots';
import {
  locationNodesApi,
  NODE_TYPE_LABEL,
  type Allocation,
  type LocationNode,
} from '@/lib/api/location-nodes';

interface Props {
  node: LocationNode | null;
  canWrite: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}

export function NodeDetailSheet({ node, canWrite, onOpenChange, onChanged }: Props) {
  const [allocations, setAllocations] = React.useState<Allocation[]>([]);
  const [lots, setLots] = React.useState<Lot[]>([]);
  const [targets, setTargets] = React.useState<LocationNode[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Place form
  const [placeLot, setPlaceLot] = React.useState('');
  const [placeQty, setPlaceQty] = React.useState('1');

  const isSubSlot = node?.node_type === 'sub_slot';

  const reload = React.useCallback(async () => {
    if (!node) return;
    setLoading(true);
    try {
      const [allocs, lotList, tgts] = await Promise.all([
        locationNodesApi.nodeAllocations(node.id),
        lotsApi.list({ limit: 500 }),
        locationNodesApi.storageTargets(),
      ]);
      setAllocations(allocs);
      setLots(lotList);
      setTargets(tgts.filter((t) => t.id !== node.id));
    } catch {
      /* surfaced per-action */
    } finally {
      setLoading(false);
    }
  }, [node]);

  React.useEffect(() => {
    if (node) {
      setPlaceLot('');
      setPlaceQty(node.node_type === 'sub_slot' ? '1' : '');
      void reload();
    }
  }, [node, reload]);

  const place = async () => {
    if (!node || !placeLot) return;
    const qty = Number(placeQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error('Enter a quantity greater than 0');
      return;
    }
    setBusy(true);
    try {
      await locationNodesApi.place({ lot_id: placeLot, node_id: node.id, qty });
      toast.success('Lot placed');
      setPlaceLot('');
      await reload();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to place lot.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={node !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-[460px] sm:max-w-[460px]">
        {node && (
          <>
            <SheetHeader>
              <SheetTitle>{node.name}</SheetTitle>
              <SheetDescription>
                <Badge tone="neutral">{NODE_TYPE_LABEL[node.node_type]}</Badge>
                {node.can_store ? (
                  <span className="ml-2 text-xs text-text-3">
                    storage location
                  </span>
                ) : (
                  <span className="ml-2 text-xs text-text-3">
                    navigation only — cannot store lots
                  </span>
                )}
              </SheetDescription>
            </SheetHeader>
            <SheetBody className="space-y-4">
              {!node.can_store && (
                <p className="text-sm text-text-3">
                  Intermediate LN2 nodes are navigation only. Only sub-slots and
                  flat locations hold lots.
                </p>
              )}

              {node.can_store && canWrite && (
                <div className="rounded-md border border-border bg-surface p-3">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-2">
                    <PackagePlus size={14} /> Place a lot here
                  </p>
                  {isSubSlot && allocations.length > 0 ? (
                    <p className="text-xs text-warning">
                      Sub-slot is occupied (single-occupancy). Empty or transfer
                      the current vial first.
                    </p>
                  ) : (
                    <div className="flex items-end gap-2">
                      <div className="flex-1 space-y-1">
                        <Label className="text-xs">Lot</Label>
                        <Select value={placeLot} onValueChange={setPlaceLot}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select lot" />
                          </SelectTrigger>
                          <SelectContent className="max-h-72">
                            {lots.map((l) => (
                              <SelectItem key={l.id} value={l.id}>
                                <span className="font-mono text-xs">
                                  {l.lot_number}
                                </span>
                                {l.item_number && (
                                  <span className="ml-2 text-text-3">
                                    {l.item_number}
                                  </span>
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="w-20 space-y-1">
                        <Label className="text-xs">Qty</Label>
                        <Input
                          type="number"
                          min={0}
                          step="1"
                          value={placeQty}
                          disabled={isSubSlot}
                          onChange={(e) => setPlaceQty(e.target.value)}
                        />
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={place}
                        disabled={busy || !placeLot}
                      >
                        Place
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <div>
                <p className="mb-2 text-xs font-medium text-text-2">
                  Allocations {loading && <span className="text-text-3">· loading…</span>}
                </p>
                {allocations.length === 0 ? (
                  <p className="text-sm text-text-3">Nothing stored here.</p>
                ) : (
                  <div className="space-y-2">
                    {allocations.map((a) => (
                      <AllocationRow
                        key={a.id}
                        allocation={a}
                        targets={targets}
                        canWrite={canWrite}
                        onDone={async () => {
                          await reload();
                          onChanged();
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function AllocationRow({
  allocation,
  targets,
  canWrite,
  onDone,
}: {
  allocation: Allocation;
  targets: LocationNode[];
  canWrite: boolean;
  onDone: () => void | Promise<void>;
}) {
  const [mode, setMode] = React.useState<'none' | 'transfer' | 'consume'>('none');
  const [qty, setQty] = React.useState('');
  const [toNode, setToNode] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error('Enter a quantity greater than 0');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'transfer') {
        if (!toNode) {
          toast.error('Pick a destination');
          setBusy(false);
          return;
        }
        await locationNodesApi.transfer({
          allocation_id: allocation.id,
          to_node_id: toNode,
          qty: n,
        });
        toast.success('Transferred');
      } else if (mode === 'consume') {
        await locationNodesApi.consume({ allocation_id: allocation.id, qty: n });
        toast.success('Consumed');
      }
      setMode('none');
      setQty('');
      setToNode('');
      await onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Operation failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-border bg-bg-elev p-2.5 text-sm">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-mono text-xs text-accent">
            {allocation.lot_number ?? allocation.lot_id.slice(0, 8)}
          </span>
          <span className="ml-2 font-mono text-text-2">qty {allocation.qty}</span>
        </div>
        {canWrite && mode === 'none' && (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setMode('transfer')}>
              <ArrowRightLeft size={13} /> Transfer
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('consume')}>
              <Minus size={13} /> Consume
            </Button>
          </div>
        )}
      </div>

      {mode !== 'none' && (
        <div className="mt-2 flex items-end gap-2">
          {mode === 'transfer' && (
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Destination</Label>
              <Select value={toNode} onValueChange={setToNode}>
                <SelectTrigger>
                  <SelectValue placeholder="Storage target" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {targets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="w-20 space-y-1">
            <Label className="text-xs">Qty</Label>
            <Input
              type="number"
              min={0}
              step="1"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <Button size="sm" variant="primary" onClick={submit} disabled={busy}>
            {mode === 'transfer' ? 'Move' : 'Remove'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode('none')} disabled={busy}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
