'use client';

import * as React from 'react';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api/client';
import { itemsApi, type ApiItem } from '@/lib/api/items';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (item: ApiItem) => void;
}

const EMPTY = {
  code_suffix: '',
  item_name: '',
  description: '',
  unit_of_measure: '',
  is_consumable: false,
};

/** SKU is always CR-prefixed for the raw-material tier. */
const PREFIX = 'CR-';

export function NewItemDialog({ open, onOpenChange, onCreated }: Props) {
  const [form, setForm] = React.useState({ ...EMPTY });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) setForm({ ...EMPTY });
  }, [open]);

  const patch = (p: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...p }));

  const suffix = form.code_suffix.trim();
  const fullSku = `${PREFIX}${suffix}`;
  const valid = Boolean(suffix && form.item_name.trim() && form.unit_of_measure.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      const created = await itemsApi.create({
        item_code: fullSku,
        item_name: form.item_name.trim(),
        description: form.description.trim() || null,
        tier: 'CR',
        is_consumable: form.is_consumable,
        // Units are stored lower-case for consistency (e.g. "each", "ml", "box").
        unit_of_measure: form.unit_of_measure.trim().toLowerCase(),
        track_expiry: false,
      });
      onCreated(created);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to create raw material.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New Raw Material</DialogTitle>
            <DialogDescription>
              Create a new raw material (CR tier). SKU is auto-prefixed with CR-.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="item_code">SKU</Label>
              <div className="flex items-stretch overflow-hidden rounded-md border border-border focus-within:ring-2 focus-within:ring-accent">
                <span className="flex select-none items-center border-r border-border bg-surface-2 px-3 text-sm text-text-2">
                  {PREFIX}
                </span>
                <input
                  id="item_code"
                  value={form.code_suffix}
                  onChange={(e) => patch({ code_suffix: e.target.value })}
                  placeholder="001"
                  autoFocus
                  className="w-full bg-transparent px-3 py-2 text-sm outline-none placeholder:text-text-3"
                />
              </div>
              {suffix && (
                <p className="text-xs text-text-3">
                  Full SKU: <span className="font-mono">{fullSku}</span>
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="item_name">Name</Label>
              <Input
                id="item_name"
                value={form.item_name}
                onChange={(e) => patch({ item_name: e.target.value })}
                placeholder="Medical Tube, PVC 6mm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="item_desc">Description</Label>
              <Textarea
                id="item_desc"
                value={form.description}
                onChange={(e) => patch({ description: e.target.value })}
                placeholder="Optional notes about this material"
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="uom">Unit</Label>
              <Input
                id="uom"
                value={form.unit_of_measure}
                onChange={(e) => patch({ unit_of_measure: e.target.value })}
                placeholder="each, mL, box…"
              />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
              <div>
                <Label htmlFor="is_consumable" className="cursor-pointer">
                  Consumable
                </Label>
                <p className="text-xs text-text-3">Blind-consumed, no lot traceability</p>
              </div>
              <Switch
                id="is_consumable"
                checked={form.is_consumable}
                onCheckedChange={(v) => patch({ is_consumable: v })}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid || saving}>
              {saving ? 'Creating…' : 'Create Raw Material'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
