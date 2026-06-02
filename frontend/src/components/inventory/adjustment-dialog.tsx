'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, Scale, ShieldCheck } from 'lucide-react';

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
import { cn } from '@/lib/utils';

import {
  movementsApi,
  type AdjustmentInput,
  type StockByLotEntry,
} from '@/lib/api/movements';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';

// Reasons capture intent for the variance report. Kept narrow on
// purpose — adjustment is a high-trust action and operators should
// reach for "count_variance" or "system_correction" rather than
// "other" unless they have to.
const REASON_OPTIONS = [
  { code: 'count_variance', label: 'Count variance' },
  { code: 'opening_balance', label: 'Opening balance' },
  { code: 'write_down', label: 'Write-down' },
  { code: 'system_correction', label: 'System correction' },
  { code: 'other', label: 'Other' },
];

const schema = z
  .object({
    stock_row: z.string().min(1, 'Pick a lot at a location'),
    sign: z.enum(['+', '-']),
    qty: z.coerce.number().positive('Quantity must be > 0'),
    reason_code: z.string().min(1, 'Pick a reason'),
    reference: z.string().max(256).optional(),
    notes: z.string().max(2048).optional(),
    available_qty: z.number().optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.sign === '-' &&
      v.available_qty !== undefined &&
      v.qty > v.available_qty
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['qty'],
        message: `Only ${v.available_qty} available — adjustment would go negative`,
      });
    }
  });

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: string;
  itemNumber: string;
  itemDescription?: string;
  onCompleted?: () => void;
}

/**
 * Dedicated stock-adjustment dialog. Lives on the item detail page only —
 * adjustments are rare, high-trust corrections (count variance, opening
 * balance back-fill), not a routine operator workflow. Keeping it out of
 * the main movement wizard means the In/Out CTA on /inventory doesn't
 * sit one click away from an action that should require deliberate
 * intent.
 *
 * The wire format is a signed ``qty_delta``; the UI splits that into a
 * +/− sign control + an unsigned magnitude so the operator can't fat-
 * finger the polarity. Negative deltas are gated against the
 * (lot, location) balance both client- and server-side.
 */
export function AdjustmentDialog({
  open,
  onOpenChange,
  itemId,
  itemNumber,
  itemDescription,
  onCompleted,
}: Props) {
  const [stockRows, setStockRows] = React.useState<StockByLotEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    getValues,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      stock_row: '',
      sign: '+',
      qty: 1,
      reason_code: 'count_variance',
      reference: '',
      notes: '',
    },
  });

  const stockRowKey = watch('stock_row');
  const sign = watch('sign');
  const qty = watch('qty');
  const reasonCode = watch('reason_code');

  // ── Load stock-by-lot for this item when the dialog opens ────────────
  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);
    movementsApi
      .stockByLot(itemId, { includeEmpty: true }, { signal: ctrl.signal })
      .then((rows) => setStockRows(rows))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load stock.',
        );
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [open, itemId]);

  // Reset on close so a fresh open doesn't show stale qty / sign.
  React.useEffect(() => {
    if (!open) {
      reset();
      setSubmitError(null);
      setShowReauth(false);
      setSubmitting(false);
    }
  }, [open, reset]);

  const selectedRow: StockByLotEntry | null = React.useMemo(() => {
    if (!stockRowKey) return null;
    const [lotId, locId] = stockRowKey.split('|');
    return (
      stockRows.find((r) => r.lot_id === lotId && r.location_id === locId) ??
      null
    );
  }, [stockRowKey, stockRows]);

  React.useEffect(() => {
    if (selectedRow) {
      setValue('available_qty', Number(selectedRow.qty_available), {
        shouldValidate: false,
      });
    } else {
      setValue('available_qty', undefined, { shouldValidate: false });
    }
  }, [selectedRow, setValue]);

  // ── Live impact preview ──────────────────────────────────────────────
  const qtyNum = Number(qty);
  const signedDelta = (sign === '-' ? -1 : 1) * (Number.isFinite(qtyNum) ? qtyNum : 0);
  const before = selectedRow ? Number(selectedRow.qty_available) : null;
  const after = before !== null ? before + signedDelta : null;

  const reasonLabel =
    REASON_OPTIONS.find((o) => o.code === reasonCode)?.label ?? reasonCode;

  const attestation = (() => {
    if (!selectedRow) return '';
    const desc = itemDescription ?? itemNumber;
    const signWord = signedDelta >= 0 ? '+' : '−';
    return `I attest this adjustment of ${signWord}${Math.abs(signedDelta)} unit(s) of ${desc} at ${selectedRow.location_code} (lot ${selectedRow.lot_number}) for ${reasonLabel.toLowerCase()} is accurate.`;
  })();

  const goToReview = (_values: FormValues): void => {
    setShowReauth(true);
    setSubmitError(null);
  };

  const submit = async (evidence: ReauthResponse): Promise<void> => {
    const v = getValues();
    if (!selectedRow) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload: AdjustmentInput = {
        item_id: itemId,
        location_id: selectedRow.location_id,
        lot_id: selectedRow.lot_id,
        qty_delta: signedDelta,
        reason_code: v.reason_code,
        reference: v.reference ? v.reference : null,
        notes: v.notes ? v.notes : null,
        evidence_id: evidence.evidence_id,
      };
      const created = await movementsApi.adjustment(payload);
      const signWord = Number(created.qty_delta) >= 0 ? '+' : '−';
      toast.success('Adjustment recorded', {
        description: `${created.item_number} · ${signWord}${created.qty_abs} at ${
          created.from_location_code ?? '—'
        }`,
      });
      onCompleted?.();
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
        } else {
          setSubmitError(err.message);
        }
      } else {
        setSubmitError('Failed to record adjustment. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Only positive-balance rows are pickable — the (lot, location) row
  // has to exist in v_lot_stock for the FK to resolve. Operators
  // back-filling a never-seen-here lot create it through a receipt.
  const pickableRows = React.useMemo(
    () => stockRows.filter((r) => Number(r.qty_available) > 0),
    [stockRows],
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <form onSubmit={handleSubmit(goToReview)}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Scale size={16} aria-hidden /> Adjust stock
              </DialogTitle>
              <DialogDescription>
                Signed correction to the (lot, location) balance for{' '}
                <span className="font-mono text-accent">{itemNumber}</span>. Use
                after a physical count or to back-fill an opening balance — a
                signed ledger row will be written under your e-signature.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-4">
              {loadError && (
                <p
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
                >
                  {loadError}
                </p>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="adj-stockrow">
                  Lot & location <span className="text-danger">*</span>
                </Label>
                <Select
                  value={stockRowKey}
                  onValueChange={(v) =>
                    setValue('stock_row', v, { shouldValidate: true })
                  }
                  disabled={loading || pickableRows.length === 0}
                >
                  <SelectTrigger
                    id="adj-stockrow"
                    aria-invalid={Boolean(errors.stock_row)}
                  >
                    <SelectValue
                      placeholder={
                        loading
                          ? 'Loading available stock…'
                          : pickableRows.length === 0
                            ? 'No stock recorded for this item yet'
                            : 'Select lot at location'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {pickableRows.map((r) => (
                      <SelectItem
                        key={`${r.lot_id}|${r.location_id}`}
                        value={`${r.lot_id}|${r.location_id}`}
                      >
                        <span className="font-mono text-xs">{r.lot_number}</span>
                        <span className="ml-2 text-text-2">@ {r.location_code}</span>
                        <span className="ml-2 text-text-3">
                          {Number(r.qty_available).toLocaleString()} avail
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.stock_row && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.stock_row.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="adj-qty">
                  Signed quantity <span className="text-danger">*</span>
                </Label>
                <div className="flex items-stretch gap-2">
                  <div
                    role="radiogroup"
                    aria-label="Adjustment sign"
                    className="grid grid-cols-2 gap-0 overflow-hidden rounded-md border border-border-strong"
                  >
                    {(['+', '-'] as const).map((s) => {
                      const active = s === sign;
                      return (
                        <button
                          key={s}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() =>
                            setValue('sign', s, { shouldValidate: true })
                          }
                          className={cn(
                            'w-9 text-center font-mono text-sm transition-colors',
                            active
                              ? s === '+'
                                ? 'bg-success/10 text-success'
                                : 'bg-warning/10 text-warning'
                              : 'bg-bg-elev text-text-2 hover:text-text-1',
                          )}
                        >
                          {s}
                        </button>
                      );
                    })}
                  </div>
                  <Input
                    id="adj-qty"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.001"
                    disabled={!selectedRow}
                    aria-invalid={Boolean(errors.qty)}
                    className="font-mono"
                    {...register('qty')}
                  />
                </div>
                {selectedRow && (
                  <p className="text-xs text-text-3">
                    Current balance{' '}
                    <span className="font-mono">
                      {Number(selectedRow.qty_available).toLocaleString()}
                    </span>{' '}
                    at {selectedRow.location_code}. Sign{' '}
                    <span className="font-mono">{sign}</span> applies the delta.
                  </p>
                )}
                {errors.qty && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.qty.message}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="adj-reason">
                    Reason <span className="text-danger">*</span>
                  </Label>
                  <Select
                    value={reasonCode || ''}
                    onValueChange={(v) =>
                      setValue('reason_code', v, { shouldValidate: true })
                    }
                  >
                    <SelectTrigger
                      id="adj-reason"
                      aria-invalid={Boolean(errors.reason_code)}
                    >
                      <SelectValue placeholder="Reason" />
                    </SelectTrigger>
                    <SelectContent>
                      {REASON_OPTIONS.map((o) => (
                        <SelectItem key={o.code} value={o.code}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.reason_code && (
                    <p role="alert" className="text-xs text-danger">
                      {errors.reason_code.message}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="adj-ref">Reference (count sheet #)</Label>
                  <Input
                    id="adj-ref"
                    placeholder="CYC-2026-05-29"
                    {...register('reference')}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="adj-notes">Notes</Label>
                <Input
                  id="adj-notes"
                  placeholder="Found 3 extra vials in tray B-2 during cycle count."
                  {...register('notes')}
                />
              </div>

              {before !== null && after !== null && Number.isFinite(qtyNum) && qtyNum > 0 && (
                <div
                  role="status"
                  aria-live="polite"
                  className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2.5"
                >
                  <p className="mb-1 text-xs text-text-3">
                    After this adjustment ·{' '}
                    <span className="font-mono">
                      {selectedRow?.lot_number} @ {selectedRow?.location_code}
                    </span>
                  </p>
                  <p className="flex items-baseline gap-2 font-mono text-sm">
                    <span className="text-text-2">{before.toLocaleString()}</span>
                    <span aria-hidden className="text-text-3">
                      &rarr;
                    </span>
                    <span
                      className={cn(
                        'font-semibold',
                        signedDelta >= 0 ? 'text-success' : 'text-warning',
                      )}
                    >
                      {signedDelta >= 0 ? '+' : '−'}
                      {Math.abs(signedDelta).toLocaleString()}
                    </span>
                    <span aria-hidden className="text-text-3">
                      &rarr;
                    </span>
                    <span className="font-semibold text-text-1">
                      {after.toLocaleString()}
                    </span>
                  </p>
                </div>
              )}

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
                disabled={submitting || !selectedRow}
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Recording…
                  </>
                ) : (
                  <>
                    <ShieldCheck size={14} /> Sign & record
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action="movement.adjustment"
        meaning={attestation}
        onConfirmed={submit}
        title="Sign this adjustment"
        submitLabel="Sign & record"
      />
    </>
  );
}
