'use client';

import * as React from 'react';
import { ShieldCheck } from 'lucide-react';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import { itemsApi, type ApiItemVendor } from '@/lib/api/items';
import { lotsApi, type Lot, type LotUpdateInput } from '@/lib/api/lots';

interface Props {
  lot: Lot | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (lot: Lot) => void;
}

/**
 * E-signed edit of a lot's correctable attributes — vendor, manufacture /
 * expiration dates, and unit price. ``lot_number`` and the parent item stay
 * immutable identity; the ordered **quantity is read-only here** (it is only
 * set/adjusted during receipt — intake + the receive splits). Vendor choices
 * are restricted to the item's assigned vendors. Every save consumes a fresh
 * reauth ticket minted for ``lot.update`` and records the mandatory reason.
 */
export function LotEditDialog({ lot, onOpenChange, onSaved }: Props) {
  const [itemVendors, setItemVendors] = React.useState<ApiItemVendor[]>([]);
  const [vendorId, setVendorId] = React.useState('');
  const [unitPrice, setUnitPrice] = React.useState('');
  const [mfgDate, setMfgDate] = React.useState('');
  const [expDate, setExpDate] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // Seed the form + load the item's vendors whenever a lot is opened.
  React.useEffect(() => {
    if (!lot) return;
    setVendorId(lot.vendor_id ?? '');
    setUnitPrice(lot.unit_price_amount ?? '');
    setMfgDate(lot.manufacture_date ?? '');
    setExpDate(lot.expiration_date ?? '');
    setReason('');
    setFormError(null);
    setShowReauth(false);
    setSubmitting(false);

    const ctrl = new AbortController();
    itemsApi
      .listVendors(lot.item_id, { signal: ctrl.signal })
      .then(setItemVendors)
      .catch(() => setItemVendors([]));
    return () => ctrl.abort();
  }, [lot]);

  // The vendor dropdown is the item's assigned vendors. If the lot's current
  // vendor somehow isn't in that list, surface it so it still shows / can be
  // kept (only off-list *changes* are rejected by the backend).
  const vendorOptions = React.useMemo<ApiItemVendor[]>(() => {
    if (
      lot?.vendor_id &&
      !itemVendors.some((v) => v.vendor_id === lot.vendor_id)
    ) {
      return [
        { vendor_id: lot.vendor_id, vendor_name: lot.vendor_name ?? '(current)' },
        ...itemVendors,
      ];
    }
    return itemVendors;
  }, [itemVendors, lot]);

  // Resolve only the changed fields into a patch (excluding evidence/reason).
  // Returns null (and sets an error) when invalid or empty.
  const resolvePatch = (): Omit<LotUpdateInput, 'evidence_id' | 'reason'> | null => {
    if (!lot) return null;
    const patch: Omit<LotUpdateInput, 'evidence_id' | 'reason'> = {};

    if (vendorId && vendorId !== (lot.vendor_id ?? '')) {
      patch.vendor_id = vendorId;
    }
    const mfg = mfgDate || null;
    if (mfg !== (lot.manufacture_date ?? null)) patch.manufacture_date = mfg;
    const exp = expDate || null;
    if (exp !== (lot.expiration_date ?? null)) patch.expiration_date = exp;

    if (unitPrice.trim() !== (lot.unit_price_amount ?? '')) {
      if (unitPrice.trim() === '') {
        patch.unit_price_amount = null;
      } else {
        const p = Number(unitPrice);
        if (!Number.isFinite(p) || p < 0) {
          setFormError('Unit price must be a non-negative number.');
          return null;
        }
        patch.unit_price_amount = p;
      }
    }

    if (Object.keys(patch).length === 0) {
      setFormError('No changes to save.');
      return null;
    }
    if (mfg && exp && exp < mfg) {
      setFormError('Expiration date must be on or after the manufacture date.');
      return null;
    }
    if (!reason.trim()) {
      setFormError('A reason is required for an e-signed lot edit.');
      return null;
    }
    return patch;
  };

  const openSign = () => {
    setFormError(null);
    if (resolvePatch() === null) return;
    setShowReauth(true);
  };

  const submit = async (evidence: ReauthResponse) => {
    if (!lot) return;
    const patch = resolvePatch();
    if (patch === null) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const updated = await lotsApi.update(lot.id, {
        ...patch,
        evidence_id: evidence.evidence_id,
        reason: reason.trim(),
      });
      toast.success('Lot updated', { description: lot.lot_number });
      onSaved(updated);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          setFormError('Your signature expired or was already used. Sign again.');
        } else {
          setFormError(err.message);
        }
      } else {
        setFormError('Failed to update lot. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const meaning = lot
    ? `I am correcting lot ${lot.lot_number}'s vendor, dates and/or unit price.`
    : '';

  return (
    <>
      <Dialog open={lot !== null} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit lot</DialogTitle>
            <DialogDescription>
              {lot ? (
                <>
                  <span className="font-mono text-accent">{lot.lot_number}</span> ·
                  Vendor, dates and unit price. Quantity is set at receipt and
                  can&apos;t be changed here. Recorded under your e-signature.
                </>
              ) : (
                ''
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="lot-edit-vendor">Vendor</Label>
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger id="lot-edit-vendor">
                  <SelectValue placeholder="Select vendor" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {vendorOptions.map((v) => (
                    <SelectItem key={v.vendor_id} value={v.vendor_id}>
                      {v.vendor_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lot-edit-qty">Ordered qty</Label>
                <Input
                  id="lot-edit-qty"
                  value={lot?.ordered_qty != null ? String(lot.ordered_qty) : '—'}
                  disabled
                  title="Quantity is set at receipt and can't be edited here"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lot-edit-price">Unit price</Label>
                <Input
                  id="lot-edit-price"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lot-edit-mfg">Manufacture date</Label>
                <Input
                  id="lot-edit-mfg"
                  type="date"
                  value={mfgDate}
                  onChange={(e) => setMfgDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lot-edit-exp">Expiration date</Label>
                <Input
                  id="lot-edit-exp"
                  type="date"
                  value={expDate}
                  onChange={(e) => setExpDate(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="lot-edit-reason">
                Reason for change <span className="text-danger">*</span>
              </Label>
              <Textarea
                id="lot-edit-reason"
                rows={2}
                placeholder="e.g. Corrected expiration date from the CoA"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
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
            <Button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={openSign}
              disabled={submitting}
            >
              <ShieldCheck size={14} /> Sign &amp; save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action="lot.update"
        meaning={meaning}
        onConfirmed={submit}
        title="Sign this lot edit"
        submitLabel="Sign & save"
      />
    </>
  );
}
