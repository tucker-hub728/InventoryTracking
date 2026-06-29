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
  /** Lot to edit; when null the dialog is closed. */
  lotId: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/**
 * E-signed edit of a lot's correctable attributes — vendor, manufacture /
 * expiration dates, unit price and the received quantity (``ordered_qty``).
 * ``lot_number`` and the parent item stay immutable identity. Vendor choices
 * are restricted to the item's assigned vendors. Every save consumes a fresh
 * reauth ticket minted for ``lot.update`` and records the mandatory reason
 * (the e-signature comment).
 *
 * Reducing the quantity below what is already physically placed in locations is
 * rejected by the backend (``qty_below_placed``); its message tells the
 * operator to unplace first and is surfaced verbatim.
 */
export function LotDetailEditDialog({ lotId, onOpenChange, onSaved }: Props) {
  const open = lotId !== null;

  const [lot, setLot] = React.useState<Lot | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [itemVendors, setItemVendors] = React.useState<ApiItemVendor[]>([]);
  const [vendorId, setVendorId] = React.useState('');
  const [unitPrice, setUnitPrice] = React.useState('');
  const [qtyReceived, setQtyReceived] = React.useState('');
  const [mfgDate, setMfgDate] = React.useState('');
  const [expDate, setExpDate] = React.useState('');
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // Fetch the lot (+ its item's vendors) whenever a lot id is opened.
  React.useEffect(() => {
    if (!lotId) {
      setLot(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setFormError(null);
    setShowReauth(false);
    setSubmitting(false);
    setItemVendors([]);

    lotsApi
      .get(lotId, { signal: ctrl.signal })
      .then((fetched) => {
        setLot(fetched);
        setVendorId(fetched.vendor_id ?? '');
        setUnitPrice(fetched.unit_price_amount ?? '');
        setQtyReceived(
          fetched.ordered_qty != null ? String(fetched.ordered_qty) : '',
        );
        setMfgDate(fetched.manufacture_date ?? '');
        setExpDate(fetched.expiration_date ?? '');
        return itemsApi
          .listVendors(fetched.item_id, { signal: ctrl.signal })
          .then(setItemVendors)
          .catch(() => setItemVendors([]));
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setFormError(
          err instanceof ApiError ? err.message : 'Failed to load lot.',
        );
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [lotId]);

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
  const resolvePatch = (): Omit<
    LotUpdateInput,
    'evidence_id' | 'reason'
  > | null => {
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

    const currentQty = lot.ordered_qty != null ? String(lot.ordered_qty) : '';
    if (qtyReceived.trim() !== currentQty) {
      const q = Number(qtyReceived);
      if (!Number.isInteger(q) || q < 1) {
        setFormError('Qty received must be a whole number of at least 1.');
        return null;
      }
      patch.ordered_qty = q;
    }

    if (Object.keys(patch).length === 0) {
      setFormError('No changes to save.');
      return null;
    }
    if (mfg && exp && exp < mfg) {
      setFormError('Expiration date must be on or after the manufacture date.');
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
        reason: evidence.comment ?? '',
      });
      toast.success('Lot updated', { description: updated.lot_number });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          setFormError('Your signature expired or was already used. Sign again.');
        } else if (err.code === 'qty_below_placed') {
          // Helpful sentence from the backend: remove the lot from its
          // location(s) before lowering the received quantity.
          setFormError(err.message);
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
    ? `I am correcting lot ${lot.lot_number}'s details.`
    : '';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit lot</DialogTitle>
            <DialogDescription>
              {lot ? (
                <>
                  <span className="font-mono text-accent">{lot.lot_number}</span> ·
                  Vendor, dates, unit price and received quantity. The lot number
                  is immutable. Recorded under your e-signature.
                </>
              ) : (
                'Loading lot…'
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="lot-detail-edit-number">Lot number</Label>
              <Input
                id="lot-detail-edit-number"
                className="font-mono"
                value={lot?.lot_number ?? ''}
                disabled
                title="The lot number is immutable"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="lot-detail-edit-vendor">Vendor</Label>
              <Select
                value={vendorId}
                onValueChange={setVendorId}
                disabled={!lot || loading}
              >
                <SelectTrigger id="lot-detail-edit-vendor">
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
                <Label htmlFor="lot-detail-edit-qty">Qty received</Label>
                <Input
                  id="lot-detail-edit-qty"
                  type="number"
                  inputMode="numeric"
                  step="1"
                  min={1}
                  value={qtyReceived}
                  disabled={!lot || loading}
                  onChange={(e) => setQtyReceived(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lot-detail-edit-price">Unit price</Label>
                <Input
                  id="lot-detail-edit-price"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  value={unitPrice}
                  disabled={!lot || loading}
                  onChange={(e) => setUnitPrice(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lot-detail-edit-mfg">Manufacture date</Label>
                <Input
                  id="lot-detail-edit-mfg"
                  type="date"
                  value={mfgDate}
                  disabled={!lot || loading}
                  onChange={(e) => setMfgDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lot-detail-edit-exp">Expiration date</Label>
                <Input
                  id="lot-detail-edit-exp"
                  type="date"
                  value={expDate}
                  disabled={!lot || loading}
                  onChange={(e) => setExpDate(e.target.value)}
                />
              </div>
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
              disabled={submitting || !lot || loading}
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
        commentPlaceholder="e.g. Corrected expiration date from the CoA"
        commentRequired
        onConfirmed={submit}
        title="Sign this lot edit"
        submitLabel="Sign & save"
      />
    </>
  );
}
