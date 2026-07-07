'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { LocationTreeSelect } from '@/components/locations/location-tree-select';
import { ApiError } from '@/lib/api/client';
import { transactionsApi } from '@/lib/api/transactions';
import type { ApiItem } from '@/lib/api/items';
import type { ApiLocation } from '@/lib/api/locations';
import { itemOptions } from '@/components/transactions/options';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Items available to receive. Ignored when ``item`` is provided. */
  items?: ApiItem[];
  locations: ApiLocation[];
  /** When set, the item is fixed (detail-page context) and not selectable. */
  item?: ApiItem;
  onCreated: () => void;
}

const EMPTY = {
  item_id: '',
  to_location_id: '',
  quantity: '',
  lot_number: '',
  expiry_date: '',
  notes: '',
};

export function ReceiveMaterialDialog({
  open,
  onOpenChange,
  items = [],
  locations,
  item,
  onCreated,
}: Props) {
  const [form, setForm] = React.useState({ ...EMPTY });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) setForm({ ...EMPTY, item_id: item?.id ?? '' });
  }, [open, item]);

  const itemOpts = React.useMemo(() => itemOptions(items), [items]);

  const patch = (p: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...p }));

  // Consumables track their expiration date, so it's required for them; for
  // non-consumables the expiry is optional.
  const selectedItem = item ?? items.find((i) => i.id === form.item_id);
  const expiryRequired = Boolean(selectedItem?.is_consumable);

  const valid =
    Boolean(form.item_id && form.to_location_id && Number(form.quantity) > 0) &&
    (!expiryRequired || Boolean(form.expiry_date));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      await transactionsApi.receipt({
        reference_no: null,
        notes: form.notes.trim() || null,
        lines: [
          {
            item_id: form.item_id,
            to_location_id: form.to_location_id,
            quantity: Number(form.quantity),
            lot_number: form.lot_number.trim() || null,
            expiry_date: form.expiry_date || null,
          },
        ],
      });
      toast.success('Material received');
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to receive material.');
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
              <Download size={16} /> Receive Material
              <Badge tone="success">Receipt</Badge>
            </DialogTitle>
            <DialogDescription>
              Receive raw material into inventory (capture lot # + expiration).
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label>Item</Label>
              {item ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">
                  <span className="font-mono text-xs">{item.item_code}</span>
                  <span className="truncate text-text-2">{item.item_name}</span>
                </div>
              ) : (
                <SearchableSelect
                  modal
                  options={itemOpts}
                  value={form.item_id}
                  onChange={(v) => patch({ item_id: v })}
                  placeholder="Select item…"
                  aria-label="Item"
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label>To location</Label>
              <LocationTreeSelect
                locations={locations}
                value={form.to_location_id}
                onChange={(v) => patch({ to_location_id: v })}
                placeholder="Select shelf…"
                aria-label="Destination location"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rcv_qty">Quantity</Label>
              <Input
                id="rcv_qty"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={form.quantity}
                onChange={(e) => patch({ quantity: e.target.value.replace(/[^\d]/g, '') })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rcv_lot">Lot number</Label>
              <Input
                id="rcv_lot"
                value={form.lot_number}
                onChange={(e) => patch({ lot_number: e.target.value })}
                placeholder="Lot-000"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rcv_exp">
                Expiration date{' '}
                {expiryRequired ? (
                  <span className="text-danger">*</span>
                ) : (
                  <span className="text-text-3">(optional)</span>
                )}
              </Label>
              <Input
                id="rcv_exp"
                type="date"
                value={form.expiry_date}
                onChange={(e) => patch({ expiry_date: e.target.value })}
                aria-required={expiryRequired}
              />
              {expiryRequired && (
                <p className="text-xs text-text-3">Required for consumables.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rcv_note">Note</Label>
              <Textarea
                id="rcv_note"
                value={form.notes}
                onChange={(e) => patch({ notes: e.target.value })}
                placeholder="Optional"
                rows={2}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid || saving}>
              {saving ? 'Receiving…' : 'Receive'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
