'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { ApiError } from '@/lib/api/client';
import { transactionsApi } from '@/lib/api/transactions';
import type { ApiItem } from '@/lib/api/items';
import type { ApiLocation } from '@/lib/api/locations';
import { itemOptions, locationOptions } from './options';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ApiItem[];
  locations: ApiLocation[];
  onCreated: () => void;
}

interface LineDraft {
  key: string;
  item_id: string;
  to_location_id: string;
  quantity: string;
  lot_number: string;
  expiry_date: string;
}

let seq = 0;
const newLine = (): LineDraft => ({
  key: `l${seq++}`,
  item_id: '',
  to_location_id: '',
  quantity: '',
  lot_number: '',
  expiry_date: '',
});

export function ReceiveDialog({ open, onOpenChange, items, locations, onCreated }: Props) {
  const [reference, setReference] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [lines, setLines] = React.useState<LineDraft[]>([newLine()]);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setReference('');
      setNotes('');
      setLines([newLine()]);
    }
  }, [open]);

  const itemOpts = React.useMemo(() => itemOptions(items), [items]);
  const locOpts = React.useMemo(() => locationOptions(locations), [locations]);

  const patchLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const valid = lines.every(
    (l) => l.item_id && l.to_location_id && Number(l.quantity) > 0,
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      await transactionsApi.receipt({
        reference_no: reference.trim() || null,
        notes: notes.trim() || null,
        lines: lines.map((l) => ({
          item_id: l.item_id,
          to_location_id: l.to_location_id,
          quantity: Number(l.quantity),
          lot_number: l.lot_number.trim() || null,
          expiry_date: l.expiry_date || null,
        })),
      });
      toast.success('Receipt recorded');
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to record receipt.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Receive stock</DialogTitle>
            <DialogDescription>Add received items to their destination locations.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rcpt_ref">Reference # (optional)</Label>
                <Input
                  id="rcpt_ref"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="PO / packing slip"
                />
              </div>
            </div>

            <div className="space-y-3">
              {lines.map((l, i) => (
                <div key={l.key} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-text-2">Line {i + 1}</span>
                    {lines.length > 1 && (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Remove line"
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      >
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Item</Label>
                      <SearchableSelect
                        modal
                        options={itemOpts}
                        value={l.item_id}
                        onChange={(v) => patchLine(l.key, { item_id: v })}
                        placeholder="Select item…"
                        aria-label="Item"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Destination location</Label>
                      <SearchableSelect
                        modal
                        options={locOpts}
                        value={l.to_location_id}
                        onChange={(v) => patchLine(l.key, { to_location_id: v })}
                        placeholder="Select location…"
                        aria-label="Destination location"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Quantity</Label>
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        value={l.quantity}
                        onChange={(e) => patchLine(l.key, { quantity: e.target.value })}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Lot # (opt.)</Label>
                        <Input
                          value={l.lot_number}
                          onChange={(e) => patchLine(l.key, { lot_number: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Expiry (opt.)</Label>
                        <Input
                          type="date"
                          value={l.expiry_date}
                          onChange={(e) => patchLine(l.key, { expiry_date: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <Button type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, newLine()])}>
                <Plus size={14} /> Add line
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rcpt_notes">Notes (optional)</Label>
              <Textarea
                id="rcpt_notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid || saving}>
              {saving ? 'Recording…' : 'Record receipt'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
