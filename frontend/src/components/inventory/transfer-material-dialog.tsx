'use client';

import * as React from 'react';
import { ArrowLeftRight, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';

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
import { LocationTreeSelect } from '@/components/locations/location-tree-select';
import { ApiError } from '@/lib/api/client';
import { transactionsApi } from '@/lib/api/transactions';
import type { ApiItem, ApiItemStockRow } from '@/lib/api/items';
import type { ApiLocation } from '@/lib/api/locations';
import { toNum } from '@/lib/api/helpers';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ApiItem;
  /** This item's per-location stock — drives the source list + preview. */
  stock: ApiItemStockRow[];
  locations: ApiLocation[];
  onCreated: () => void;
}

export function TransferMaterialDialog({
  open,
  onOpenChange,
  item,
  stock,
  locations,
  onCreated,
}: Props) {
  const [fromId, setFromId] = React.useState('');
  const [toId, setToId] = React.useState('');
  const [quantity, setQuantity] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setFromId('');
      setToId('');
      setQuantity('');
    }
  }, [open]);

  // On-hand for this item per location, summed across lots.
  const onHandByLocation = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const row of stock) {
      map.set(row.location_id, (map.get(row.location_id) ?? 0) + toNum(row.quantity_available));
    }
    return map;
  }, [stock]);

  // Source = only locations where this item currently has stock.
  const sourceIds = React.useMemo(
    () => new Set([...onHandByLocation].filter(([, q]) => q > 0).map(([id]) => id)),
    [onHandByLocation],
  );

  const availableAtSource = fromId ? (onHandByLocation.get(fromId) ?? 0) : 0;
  const currentAtTarget = toId ? (onHandByLocation.get(toId) ?? 0) : 0;
  const qty = Number(quantity) || 0;

  const overAvailable = qty > availableAtSource;
  const sameLocation = Boolean(fromId) && fromId === toId;
  const valid = Boolean(fromId && toId) && !sameLocation && qty > 0 && !overAvailable;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      await transactionsApi.transfer({
        lines: [{ item_id: item.id, from_location_id: fromId, to_location_id: toId, quantity: qty }],
      });
      toast.success('Stock transferred');
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to transfer stock.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowLeftRight size={16} /> Transfer Stock
            </DialogTitle>
            <DialogDescription>Move this item between locations.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label>Item</Label>
              <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">
                <span className="font-mono text-xs">{item.item_code}</span>
                <span className="truncate text-text-2">{item.item_name}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>From location</Label>
                <LocationTreeSelect
                  locations={locations}
                  selectableIds={sourceIds}
                  value={fromId}
                  onChange={setFromId}
                  placeholder="Source…"
                  aria-label="From location"
                />
              </div>
              <div className="space-y-1.5">
                <Label>To location</Label>
                <LocationTreeSelect
                  locations={locations}
                  value={toId}
                  onChange={setToId}
                  placeholder="Destination…"
                  aria-label="To location"
                />
              </div>
            </div>
            {sameLocation && (
              <p className="text-xs text-danger">From and to locations must differ.</p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="xfer_qty">Quantity</Label>
              <Input
                id="xfer_qty"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
              />
              {overAvailable && (
                <p className="text-xs text-danger">
                  Only {availableAtSource.toLocaleString()} {item.unit_of_measure} available at the source.
                </p>
              )}
            </div>

            {/* Live preview */}
            {fromId && (
              <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
                <div className="mb-2 text-[11px] uppercase tracking-wider text-text-3">Preview</div>
                <PreviewRow
                  label="Source"
                  before={availableAtSource}
                  after={availableAtSource - qty}
                  uom={item.unit_of_measure}
                />
                {toId && !sameLocation && (
                  <PreviewRow
                    label="Destination"
                    before={currentAtTarget}
                    after={currentAtTarget + qty}
                    uom={item.unit_of_measure}
                  />
                )}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid || saving}>
              {saving ? 'Transferring…' : 'Transfer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PreviewRow({
  label,
  before,
  after,
  uom,
}: {
  label: string;
  before: number;
  after: number;
  uom: string;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-text-2">{label}</span>
      <span className="flex items-center gap-1.5 tabular-nums">
        <span className="text-text-3">{before.toLocaleString()}</span>
        <ArrowRight size={12} className="text-text-3" />
        <span className="font-semibold">{after.toLocaleString()}</span>
        <span className="text-xs text-text-3">{uom}</span>
      </span>
    </div>
  );
}
