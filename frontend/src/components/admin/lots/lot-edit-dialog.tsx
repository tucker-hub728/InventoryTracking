'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import {
  lotsApi,
  LOT_STATUS_OPTIONS,
  type Lot,
  type LotStatus,
  type LotUpdateInput,
} from '@/lib/api/lots';
import { vendorsApi, type Vendor } from '@/lib/api/vendors';

const STATUS_CODES = LOT_STATUS_OPTIONS.map((o) => o.code) as [LotStatus, ...LotStatus[]];
const NO_VENDOR = '__none__';

const schema = z
  .object({
    status: z.enum(STATUS_CODES),
    vendor_id: z.string().optional(),
    manufacture_date: z.string().optional(),
    expiration_date: z.string().optional(),
    coa_url: z.string().url('Must be a valid URL').optional().or(z.literal('')),
    notes: z.string().max(2048).optional(),
    reason: z
      .string()
      .trim()
      .min(1, 'A reason for the change is required')
      .max(512, 'Keep the reason under 512 characters'),
  })
  .refine(
    (v) =>
      !v.manufacture_date ||
      !v.expiration_date ||
      v.expiration_date >= v.manufacture_date,
    {
      message: 'Expiration must be on or after manufacture date',
      path: ['expiration_date'],
    },
  );

type FormValues = z.infer<typeof schema>;

interface Props {
  /** The lot being edited; ``null`` keeps the dialog closed. */
  lot: Lot | null;
  onOpenChange: (open: boolean) => void;
  onUpdated: (lot: Lot) => void;
}

/** Normalise an optional text field to ``string | null`` for comparison/wire. */
function nz(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t.length ? t : null;
}

/**
 * E-signed lot edit. Lots must be correctable after entry (e.g. a wrong
 * expiration date), but every change is a GxP-significant event: it
 * requires a re-authentication signature and a recorded reason, and the
 * backend writes a before/after audit row linked to the signature.
 *
 * ``lot_number`` and the parent item are the lot's identity and are
 * shown read-only — only the correctable fields are editable.
 */
export function LotEditDialog({ lot, onOpenChange, onUpdated }: Props) {
  const open = lot !== null;

  const [vendors, setVendors] = React.useState<Vendor[]>([]);
  const [vendorsLoading, setVendorsLoading] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    getValues,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      status: 'available',
      vendor_id: NO_VENDOR,
      manufacture_date: '',
      expiration_date: '',
      coa_url: '',
      notes: '',
      reason: '',
    },
  });

  // Hydrate the form from the lot each time the dialog opens for a row.
  React.useEffect(() => {
    if (!lot) return;
    reset({
      status: lot.status,
      vendor_id: lot.vendor_id ?? NO_VENDOR,
      manufacture_date: lot.manufacture_date ?? '',
      expiration_date: lot.expiration_date ?? '',
      coa_url: lot.coa_url ?? '',
      notes: lot.notes ?? '',
      reason: '',
    });
    setSubmitError(null);
    setShowReauth(false);
    setSubmitting(false);
  }, [lot, reset]);

  // Vendor picker source. Active-only matches the create dialog; if the
  // lot's current vendor was since deactivated it still renders because
  // we seed the select value from the lot, not the list.
  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setVendorsLoading(true);
    vendorsApi
      .list({ activeOnly: true, signal: ctrl.signal })
      .then(setVendors)
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        // Non-fatal — the operator can still edit non-vendor fields.
        setVendors([]);
      })
      .finally(() => setVendorsLoading(false));
    return () => ctrl.abort();
  }, [open]);

  const status = watch('status');
  const vendorId = watch('vendor_id');

  // Build the minimal patch (only changed fields) so the audit diff is
  // clean. ``reason`` is excluded — it's metadata, not a lot column.
  const buildChangedFields = React.useCallback(
    (v: FormValues): Omit<LotUpdateInput, 'evidence_id' | 'reason'> => {
      if (!lot) return {};
      const changed: Omit<LotUpdateInput, 'evidence_id' | 'reason'> = {};
      const nextVendor = v.vendor_id === NO_VENDOR ? null : (v.vendor_id ?? null);
      if (v.status !== lot.status) changed.status = v.status;
      if (nextVendor !== (lot.vendor_id ?? null)) changed.vendor_id = nextVendor;
      if (nz(v.manufacture_date) !== (lot.manufacture_date ?? null))
        changed.manufacture_date = nz(v.manufacture_date);
      if (nz(v.expiration_date) !== (lot.expiration_date ?? null))
        changed.expiration_date = nz(v.expiration_date);
      if (nz(v.coa_url) !== (lot.coa_url ?? null)) changed.coa_url = nz(v.coa_url);
      if (nz(v.notes) !== (lot.notes ?? null)) changed.notes = nz(v.notes);
      return changed;
    },
    [lot],
  );

  const hasChanges = (() => {
    const v = watch();
    return Object.keys(buildChangedFields(v as FormValues)).length > 0;
  })();

  // Step 1 — form is valid; gate the actual write behind the signature.
  const goToReview = (v: FormValues): void => {
    setSubmitError(null);
    if (Object.keys(buildChangedFields(v)).length === 0) {
      setSubmitError('No changes to save — edit a field before signing.');
      return;
    }
    setShowReauth(true);
  };

  // Step 2 — password verified, evidence minted; send the patch.
  const submit = async (evidence: ReauthResponse): Promise<void> => {
    if (!lot) return;
    const v = getValues();
    const changed = buildChangedFields(v);
    if (Object.keys(changed).length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await lotsApi.update(lot.id, {
        ...changed,
        evidence_id: evidence.evidence_id,
        reason: v.reason.trim(),
      });
      onUpdated(updated);
      toast.success('Lot updated', {
        description: `${updated.item_number ?? ''} · ${updated.lot_number}`,
      });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          setSubmitError(
            'Your signature expired or was already used. Please sign again.',
          );
        } else if (err.code === 'lot_dates_inverted') {
          setSubmitError(err.message);
        } else {
          setSubmitError(err.message);
        }
      } else {
        setSubmitError('Failed to update lot. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const attestation = lot
    ? `I confirm these corrections to lot ${lot.lot_number}${
        lot.item_number ? ` (${lot.item_number})` : ''
      } are accurate and authorised.`
    : '';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <form noValidate onSubmit={handleSubmit(goToReview)}>
            <DialogHeader>
              <DialogTitle>Edit lot</DialogTitle>
              <DialogDescription>
                Correct this lot&apos;s details. Changes are recorded under your
                electronic signature with a reason — the lot # and item can&apos;t
                be changed.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              {/* Read-only identity */}
              <div className="grid grid-cols-2 gap-3 rounded-md border border-border bg-surface px-3 py-2.5 text-xs">
                <div>
                  <div className="text-text-3">Lot #</div>
                  <div className="font-mono text-text-1">{lot?.lot_number}</div>
                </div>
                <div>
                  <div className="text-text-3">Item</div>
                  <div className="font-mono text-accent">{lot?.item_number ?? '—'}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-lot-status">Lot status</Label>
                  <Select
                    value={status}
                    onValueChange={(v) =>
                      setValue('status', v as LotStatus, { shouldValidate: true })
                    }
                  >
                    <SelectTrigger id="edit-lot-status">
                      <SelectValue placeholder="Lot status" />
                    </SelectTrigger>
                    <SelectContent>
                      {LOT_STATUS_OPTIONS.map((o) => (
                        <SelectItem key={o.code} value={o.code}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-lot-vendor">Vendor</Label>
                  <Select
                    value={vendorId || NO_VENDOR}
                    onValueChange={(v) => setValue('vendor_id', v, { shouldValidate: true })}
                    disabled={vendorsLoading}
                  >
                    <SelectTrigger id="edit-lot-vendor">
                      <SelectValue
                        placeholder={vendorsLoading ? 'Loading vendors…' : 'Vendor'}
                      />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={NO_VENDOR}>— No vendor —</SelectItem>
                      {vendors.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-lot-mfg">Manufacture date</Label>
                  <Input id="edit-lot-mfg" type="date" {...register('manufacture_date')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-lot-exp">Expiration date</Label>
                  <Input
                    id="edit-lot-exp"
                    type="date"
                    aria-invalid={Boolean(errors.expiration_date)}
                    {...register('expiration_date')}
                  />
                  {errors.expiration_date && (
                    <p role="alert" className="text-xs text-danger">
                      {errors.expiration_date.message}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-lot-coa">Certificate of Analysis URL</Label>
                <Input
                  id="edit-lot-coa"
                  type="url"
                  placeholder="https://..."
                  aria-invalid={Boolean(errors.coa_url)}
                  {...register('coa_url')}
                />
                {errors.coa_url && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.coa_url.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-lot-notes">Notes</Label>
                <Input id="edit-lot-notes" {...register('notes')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-lot-reason">
                  Reason for change <span className="text-danger">*</span>
                </Label>
                <Textarea
                  id="edit-lot-reason"
                  placeholder="e.g. Corrected expiration date to match the supplier's CoA."
                  aria-invalid={Boolean(errors.reason)}
                  {...register('reason')}
                />
                {errors.reason && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.reason.message}
                  </p>
                )}
                <p className="text-xs text-text-3">
                  Recorded on the audit trail with your signature.
                </p>
              </div>

              {submitError && (
                <p
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
                >
                  {submitError}
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
                type="submit"
                variant="primary"
                disabled={submitting || !hasChanges}
              >
                <ShieldCheck size={14} /> Sign &amp; save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action="lot.update"
        meaning={attestation}
        onConfirmed={submit}
        title="Sign this lot change"
        submitLabel="Sign & save"
      />
    </>
  );
}
