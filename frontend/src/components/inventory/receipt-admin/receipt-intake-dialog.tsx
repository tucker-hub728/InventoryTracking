'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';

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
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { itemsApi, type ApiItem, type ApprovedVendor } from '@/lib/api/items';
import { vendorsApi, type Vendor } from '@/lib/api/vendors';
import {
  receivingApi,
  type ReceiptIntakeInput,
  type ReceiptIntakeLotInput,
  type ReceiptTransaction,
} from '@/lib/api/receiving';

const NEW_VENDOR = '__new__';

interface LineDraft {
  key: string;
  lot_number: string;
  quantity: string;
  vendorChoice: string; // vendor id | NEW_VENDOR | ''
  vendor_name: string;
  unit_price: string;
  po_reference: string;
  manufacture_date: string;
  expiration_date: string;
}

let _seq = 0;
function emptyLine(): LineDraft {
  _seq += 1;
  return {
    key: `line-${_seq}`,
    lot_number: '',
    quantity: '',
    vendorChoice: '',
    vendor_name: '',
    unit_price: '',
    po_reference: '',
    manufacture_date: '',
    expiration_date: '',
  };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (txn: ReceiptTransaction) => void;
}

/**
 * Receipt Admin intake (Requirements v2 §4). Creates ON_ORDER lots under
 * a new receipt-transaction header. No stock moves yet, so it is not
 * e-signed. Vendor is mandatory per lot; an unknown vendor can be typed
 * (created on the fly) and optionally added to the item's vendor list.
 */
export function ReceiptIntakeDialog({ open, onOpenChange, onCreated }: Props) {
  const [items, setItems] = React.useState<ApiItem[]>([]);
  const [vendors, setVendors] = React.useState<Vendor[]>([]);
  const [approved, setApproved] = React.useState<ApprovedVendor[]>([]);
  const [loading, setLoading] = React.useState(false);

  const [itemId, setItemId] = React.useState('');
  const [poRef, setPoRef] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [lines, setLines] = React.useState<LineDraft[]>([emptyLine()]);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // Load items + vendors when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    Promise.all([
      itemsApi.list(
        { limit: 200, sort: 'item_number', direction: 'asc' },
        { signal: ctrl.signal },
      ),
      vendorsApi.list({ activeOnly: true, signal: ctrl.signal }),
    ])
      .then(([itemList, vendorList]) => {
        setItems(itemList.items);
        setVendors(vendorList);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setFormError(err instanceof ApiError ? err.message : 'Failed to load data.');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [open]);

  // Load the item's approved vendors so the picker can suggest them first.
  React.useEffect(() => {
    if (!open || !itemId) {
      setApproved([]);
      return;
    }
    const ctrl = new AbortController();
    itemsApi
      .listApprovedVendors(itemId, { signal: ctrl.signal })
      .then(setApproved)
      .catch(() => setApproved([]));
    return () => ctrl.abort();
  }, [open, itemId]);

  // Reset on close.
  React.useEffect(() => {
    if (!open) {
      setItemId('');
      setPoRef('');
      setNotes('');
      setLines([emptyLine()]);
      setSubmitting(false);
      setFormError(null);
    }
  }, [open]);

  const patchLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const approvedIds = React.useMemo(
    () => new Set(approved.map((a) => a.vendor_id)),
    [approved],
  );

  const validate = (): ReceiptIntakeInput | null => {
    if (!itemId) {
      setFormError('Pick an item.');
      return null;
    }
    if (lines.length === 0) {
      setFormError('Add at least one lot.');
      return null;
    }
    const seenNumbers = new Set<string>();
    const outLots: ReceiptIntakeLotInput[] = [];
    for (const l of lines) {
      const lotNo = l.lot_number.trim();
      if (!lotNo) {
        setFormError('Every lot needs a lot number.');
        return null;
      }
      if (seenNumbers.has(lotNo.toLowerCase())) {
        setFormError(`Duplicate lot number "${lotNo}".`);
        return null;
      }
      seenNumbers.add(lotNo.toLowerCase());
      const qty = Number(l.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        setFormError(`Lot "${lotNo}" needs a quantity greater than 0.`);
        return null;
      }
      const usingNew = l.vendorChoice === NEW_VENDOR;
      if (!l.vendorChoice) {
        setFormError(`Pick a vendor for lot "${lotNo}" (vendor is mandatory).`);
        return null;
      }
      if (usingNew && !l.vendor_name.trim()) {
        setFormError(`Enter the new vendor name for lot "${lotNo}".`);
        return null;
      }
      if (
        l.manufacture_date &&
        l.expiration_date &&
        l.expiration_date < l.manufacture_date
      ) {
        setFormError(`Lot "${lotNo}": expiration must be on or after manufacture date.`);
        return null;
      }
      outLots.push({
        lot_number: lotNo,
        quantity: qty,
        vendor_id: usingNew ? undefined : l.vendorChoice,
        vendor_name: usingNew ? l.vendor_name.trim() : undefined,
        unit_price: l.unit_price ? Number(l.unit_price) : undefined,
        po_reference: l.po_reference.trim() || undefined,
        manufacture_date: l.manufacture_date || undefined,
        expiration_date: l.expiration_date || undefined,
      });
    }
    return {
      item_id: itemId,
      po_reference: poRef.trim() || undefined,
      notes: notes.trim() || undefined,
      lots: outLots,
    };
  };

  const submit = async () => {
    setFormError(null);
    const payload = validate();
    if (!payload) return;
    setSubmitting(true);
    try {
      const created = await receivingApi.createIntake(payload);
      toast.success('Intake created', {
        description: `${created.item_number ?? ''} · ${created.lots.length} lot(s) on order`,
      });
      onCreated(created);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
      } else {
        setFormError('Failed to create intake. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New receipt intake</DialogTitle>
          <DialogDescription>
            Place an order — creates on-order lots. Stock is recorded later at
            physical receipt. Vendor is required for every lot.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="intake-item">
                Item <span className="text-danger">*</span>
              </Label>
              <Select
                value={itemId}
                onValueChange={setItemId}
                disabled={loading || items.length === 0}
              >
                <SelectTrigger id="intake-item">
                  <SelectValue placeholder={loading ? 'Loading…' : 'Select item'} />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {items.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      <span className="font-mono text-xs">{i.item_number}</span>
                      <span className="ml-2 text-text-2">{i.description}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="intake-po">PO # (optional)</Label>
              <Input
                id="intake-po"
                placeholder="PO-2026-0042"
                value={poRef}
                onChange={(e) => setPoRef(e.target.value)}
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            {lines.map((line, idx) => (
              <div
                key={line.key}
                className="rounded-md border border-border bg-surface p-3"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-text-2">
                    Lot {idx + 1}
                  </span>
                  {lines.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setLines((prev) => prev.filter((l) => l.key !== line.key))
                      }
                      aria-label="Remove lot line"
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label>
                      Lot number <span className="text-danger">*</span>
                    </Label>
                    <Input
                      className="font-mono"
                      placeholder="L-20260618-A"
                      value={line.lot_number}
                      onChange={(e) =>
                        patchLine(line.key, { lot_number: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>
                      Ordered qty <span className="text-danger">*</span>
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      step="1"
                      value={line.quantity}
                      onChange={(e) =>
                        patchLine(line.key, { quantity: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Unit price</Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="0.00"
                      value={line.unit_price}
                      onChange={(e) =>
                        patchLine(line.key, { unit_price: e.target.value })
                      }
                    />
                  </div>
                </div>

                <div className="mt-3 space-y-1.5">
                  <Label>
                    Vendor <span className="text-danger">*</span>
                  </Label>
                  <Select
                    value={line.vendorChoice}
                    onValueChange={(v) => patchLine(line.key, { vendorChoice: v })}
                    disabled={loading}
                  >
                    <SelectTrigger
                      aria-label="Vendor"
                    >
                      <SelectValue placeholder="Select or add vendor" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={NEW_VENDOR}>+ New vendor…</SelectItem>
                      {approved.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>This item&apos;s vendors</SelectLabel>
                          {approved.map((a) => (
                            <SelectItem key={a.vendor_id} value={a.vendor_id}>
                              {a.vendor_name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                      <SelectGroup>
                        <SelectLabel>All vendors</SelectLabel>
                        {vendors
                          .filter((v) => !approvedIds.has(v.id))
                          .map((v) => (
                            <SelectItem key={v.id} value={v.id}>
                              {v.name}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {approved.length > 0 &&
                    line.vendorChoice &&
                    line.vendorChoice !== NEW_VENDOR &&
                    !approvedIds.has(line.vendorChoice) && (
                      <p className="text-xs text-warning">
                        Not currently one of this item&apos;s vendors — it will be
                        added, and the lot flagged as a new vendor for this item.
                      </p>
                    )}
                </div>

                {line.vendorChoice === NEW_VENDOR && (
                  <div className="mt-3 space-y-1.5 rounded-md border border-dashed border-border p-2.5">
                    <Label>
                      New vendor name <span className="text-danger">*</span>
                    </Label>
                    <Input
                      placeholder="Acme Biologicals"
                      value={line.vendor_name}
                      onChange={(e) =>
                        patchLine(line.key, { vendor_name: e.target.value })
                      }
                    />
                    <p className="text-xs text-text-3">
                      Added to this item&apos;s vendors automatically.
                    </p>
                  </div>
                )}

                <div className="mt-3 grid grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label>Manufacture date</Label>
                    <Input
                      type="date"
                      value={line.manufacture_date}
                      onChange={(e) =>
                        patchLine(line.key, { manufacture_date: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Expiration date</Label>
                    <Input
                      type="date"
                      value={line.expiration_date}
                      onChange={(e) =>
                        patchLine(line.key, { expiration_date: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Lot PO # (optional)</Label>
                    <Input
                      placeholder="overrides header"
                      value={line.po_reference}
                      onChange={(e) =>
                        patchLine(line.key, { po_reference: e.target.value })
                      }
                    />
                  </div>
                </div>
              </div>
            ))}

            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLines((prev) => [...prev, emptyLine()])}
            >
              <Plus size={14} /> Add another lot
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="intake-notes">Notes (optional)</Label>
            <Textarea
              id="intake-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {formError && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
            >
              {formError}
            </p>
          )}
        </DialogBody>

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create intake'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
