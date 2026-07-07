'use client';

import * as React from 'react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogBody,
  DialogContent,
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
import { itemsApi, type ApiItem, type ApiItemDetail } from '@/lib/api/items';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ApiItemDetail;
  onSaved: (item: ApiItem) => void;
}

export function EditItemDialog({ open, onOpenChange, item, onSaved }: Props) {
  const [name, setName] = React.useState(item.item_name);
  const [description, setDescription] = React.useState(item.description ?? '');
  const [uom, setUom] = React.useState(item.unit_of_measure);
  const [consumable, setConsumable] = React.useState(item.is_consumable);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(item.item_name);
      setDescription(item.description ?? '');
      setUom(item.unit_of_measure);
      setConsumable(item.is_consumable);
    }
  }, [open, item]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !name.trim() || !uom.trim()) return;
    setSaving(true);
    try {
      const updated = await itemsApi.update(item.id, {
        item_name: name.trim(),
        description: description.trim() || null,
        unit_of_measure: uom.trim(),
        is_consumable: consumable,
      });
      onSaved(updated);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update raw material.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Edit {item.item_code}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit_name">Name</Label>
              <Input id="edit_name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit_desc">Description</Label>
              <Textarea
                id="edit_desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit_uom">Unit</Label>
              <Input id="edit_uom" value={uom} onChange={(e) => setUom(e.target.value)} />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
              <Label htmlFor="edit_consumable" className="cursor-pointer">
                Consumable
              </Label>
              <Switch id="edit_consumable" checked={consumable} onCheckedChange={setConsumable} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving || !name.trim() || !uom.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
