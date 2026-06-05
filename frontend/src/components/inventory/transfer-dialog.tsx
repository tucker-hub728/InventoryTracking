'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRightLeft, Loader2, ShieldCheck } from 'lucide-react';

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

import { itemsApi, type ApiItem } from '@/lib/api/items';
import { locationsApi, type Location } from '@/lib/api/locations';
import {
  movementsApi,
  type StockByLotEntry,
  type TransferInput,
} from '@/lib/api/movements';
import {
  storageApi,
  buildCapacityMap,
  type LocationCapacity,
} from '@/lib/api/storage';
import { ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import type { ReauthResponse } from '@/lib/api/auth';

const schema = z
  .object({
    item_id: z.string().uuid('Pick an item'),
    stock_row: z.string().min(1, 'Pick a lot at a source location'),
    to_location_id: z.string().uuid('Pick a destination location'),
    qty: z.coerce
      .number()
      .int('Units must be a whole number')
      .positive('Units must be > 0'),
    available_qty: z.number().optional(),
    from_location_id: z.string().optional(),
    // Free rack positions at the destination. ``undefined`` for a ledger-only
    // (rack-less) destination, which the backend fills without a position cap.
    dest_empty_positions: z.number().optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.from_location_id &&
      v.to_location_id &&
      v.from_location_id === v.to_location_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to_location_id'],
        message: 'Destination must differ from source',
      });
    }
    if (
      v.available_qty !== undefined &&
      v.qty > v.available_qty
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['qty'],
        message: `Only ${v.available_qty} available at the source`,
      });
    }
    // Mirror the backend's not_enough_empty_positions guard on the destination
    // leg so the operator sees the cap before signing.
    if (
      v.dest_empty_positions !== undefined &&
      v.qty > v.dest_empty_positions
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['qty'],
        message:
          `Destination has only ${v.dest_empty_positions} empty position(s); ` +
          `cannot place ${v.qty} unit(s).`,
      });
    }
  });

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Optional preset — when supplied the item picker is hidden and the
   * lot/source picker scopes to this item. Used from the detail page.
   */
  presetItemId?: string;
  presetItemNumber?: string;
  onCompleted?: () => void;
}

/**
 * Transfer dialog — moves stock between two locations. Backend writes
 * a transfer_out + transfer_in pair atomically under one e-signature.
 *
 * UX:
 *   1. Item picker (hidden when ``presetItemId`` is set).
 *   2. Lot @ source — a single picker over ``stock-by-lot`` that pins
 *      the lot AND the source location in one click. Mirrors the
 *      Stock-Out picker.
 *   3. Destination location — separate select, filtered to active
 *      locations only and to anything that isn't the source.
 *   4. Units — gated against the source balance client-side.
 *   5. Live impact preview: source - qty / dest + qty.
 *
 * Reuses the PasswordReauthDialog with ``action='movement.transfer'``.
 */
export function TransferDialog({
  open,
  onOpenChange,
  presetItemId,
  presetItemNumber,
  onCompleted,
}: Props) {
  const [items, setItems] = React.useState<ApiItem[]>([]);
  const [locations, setLocations] = React.useState<Location[]>([]);
  const [stockRows, setStockRows] = React.useState<StockByLotEntry[]>([]);
  // Per-location rack capacity (id → free/total). Drives the destination
  // free-positions preview and the qty guard. Racked locations only.
  const [capacityByLoc, setCapacityByLoc] = React.useState<
    Map<string, LocationCapacity>
  >(new Map());
  const [pickersLoading, setPickersLoading] = React.useState(false);
  const [pickersError, setPickersError] = React.useState<string | null>(null);
  const [stockLoading, setStockLoading] = React.useState(false);
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
      item_id: presetItemId ?? '',
      stock_row: '',
      to_location_id: '',
      qty: 1,
      from_location_id: '',
    },
  });

  const itemId = watch('item_id');
  const stockRowKey = watch('stock_row');
  const fromLocationId = watch('from_location_id');
  const toLocationId = watch('to_location_id');
  const qty = watch('qty');

  // ── Load pickers when the dialog opens ───────────────────────────────
  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setPickersLoading(true);
    setPickersError(null);
    Promise.all([
      itemsApi.list(
        { limit: 200, sort: 'item_number', direction: 'asc' },
        { signal: ctrl.signal },
      ),
      locationsApi.list({ activeOnly: true, signal: ctrl.signal }),
      // Optional context — a failure must not block the dialog.
      storageApi
        .listLocations({ activeOnly: true, signal: ctrl.signal })
        .catch(() => []),
    ])
      .then(([itemList, locList, storageLocs]) => {
        setItems(itemList.items);
        setLocations(locList);
        setCapacityByLoc(buildCapacityMap(storageLocs));
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setPickersError(
          err instanceof ApiError ? err.message : 'Failed to load pickers.',
        );
      })
      .finally(() => setPickersLoading(false));
    return () => ctrl.abort();
  }, [open]);

  // ── Stock rows for the chosen item ───────────────────────────────────
  React.useEffect(() => {
    if (!open || !itemId) {
      setStockRows([]);
      return;
    }
    const ctrl = new AbortController();
    setStockLoading(true);
    movementsApi
      .stockByLot(itemId, { includeEmpty: false }, { signal: ctrl.signal })
      .then((rows) => setStockRows(rows))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setStockRows([]);
      })
      .finally(() => setStockLoading(false));
    return () => ctrl.abort();
  }, [open, itemId]);

  React.useEffect(() => {
    if (!open) {
      reset();
      setSubmitError(null);
      setShowReauth(false);
      setSubmitting(false);
    }
  }, [open, reset]);

  // Re-establish presetItemId after reset closes & reopens the dialog.
  React.useEffect(() => {
    if (open && presetItemId) {
      setValue('item_id', presetItemId, { shouldValidate: false });
    }
  }, [open, presetItemId, setValue]);

  // Resolve the picked stock row + keep available_qty / from_location_id
  // in sync so the schema can validate quantity and same-loc.
  const selectedRow: StockByLotEntry | null = React.useMemo(() => {
    if (!stockRowKey) return null;
    const [lotId, locId] = stockRowKey.split('|');
    return stockRows.find((r) => r.lot_id === lotId && r.location_id === locId) ?? null;
  }, [stockRowKey, stockRows]);

  React.useEffect(() => {
    if (selectedRow) {
      setValue('available_qty', Number(selectedRow.qty_available), {
        shouldValidate: false,
      });
      setValue('from_location_id', selectedRow.location_id, {
        shouldValidate: false,
      });
    } else {
      setValue('available_qty', undefined, { shouldValidate: false });
      setValue('from_location_id', '', { shouldValidate: false });
    }
  }, [selectedRow, setValue]);

  // Destination options — active locations minus the source.
  const destOptions = React.useMemo(() => {
    return locations.filter(
      (l) => l.id !== (selectedRow?.location_id ?? fromLocationId),
    );
  }, [locations, selectedRow, fromLocationId]);

  // Rack capacity for the chosen destination. Null when none picked or the
  // destination is ledger-only (no racks → no position cap).
  const destCapacity: LocationCapacity | null = React.useMemo(() => {
    if (!toLocationId) return null;
    return capacityByLoc.get(toLocationId) ?? null;
  }, [toLocationId, capacityByLoc]);

  // Keep dest_empty_positions (used by the schema guard) in sync. Only
  // rack-backed destinations cap the qty; ledger-only ones clear it.
  React.useEffect(() => {
    if (destCapacity?.hasRacks) {
      setValue('dest_empty_positions', destCapacity.empty, {
        shouldValidate: true,
      });
    } else {
      setValue('dest_empty_positions', undefined, { shouldValidate: false });
    }
  }, [destCapacity, setValue]);

  // ── Live impact preview ──────────────────────────────────────────────
  const qtyNum = Number(qty);
  const validQty = Number.isFinite(qtyNum) && qtyNum > 0;
  const srcBefore = selectedRow ? Number(selectedRow.qty_available) : null;
  const destBefore = React.useMemo(() => {
    if (!toLocationId || !selectedRow) return null;
    const row = stockRows.find(
      (r) => r.lot_id === selectedRow.lot_id && r.location_id === toLocationId,
    );
    return row ? Number(row.qty_available) : 0;
  }, [toLocationId, selectedRow, stockRows]);

  const chosenItem = items.find((i) => i.id === itemId) ?? null;
  const itemDesc =
    chosenItem?.description ?? chosenItem?.item_number ?? presetItemNumber ?? 'item';
  const destLoc = locations.find((l) => l.id === toLocationId) ?? null;

  const attestation = (() => {
    if (!selectedRow || !destLoc) return '';
    return `I attest this transfer of ${qtyNum} unit(s) of ${itemDesc} (lot ${selectedRow.lot_number}) from ${selectedRow.location_code} to ${destLoc.code} is accurate.`;
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
      const payload: TransferInput = {
        item_id: v.item_id,
        lot_id: selectedRow.lot_id,
        from_location_id: selectedRow.location_id,
        to_location_id: v.to_location_id,
        qty: Number(v.qty),
        evidence_id: evidence.evidence_id,
      };
      const resp = await movementsApi.transfer(payload);
      toast.success('Transfer recorded', {
        description: `${resp.transfer_out.item_number} · ${resp.transfer_out.qty_abs} from ${resp.transfer_out.from_location_code ?? '—'} to ${resp.transfer_in.to_location_code ?? '—'}`,
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
        setSubmitError('Failed to record transfer. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <form onSubmit={handleSubmit(goToReview)}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ArrowRightLeft size={16} aria-hidden /> Transfer unit
              </DialogTitle>
              <DialogDescription>
                Move units between two locations. Both legs are recorded
                atomically under one e-signature, and the LN2 grid updates to match.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-4">
              {pickersError && (
                <p
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
                >
                  {pickersError}
                </p>
              )}

              {!presetItemId ? (
                <div className="space-y-1.5">
                  <Label htmlFor="tx-item">
                    Item <span className="text-danger">*</span>
                  </Label>
                  <Select
                    value={itemId}
                    onValueChange={(v) => {
                      setValue('item_id', v, { shouldValidate: true });
                      setValue('stock_row', '', { shouldValidate: false });
                      setValue('to_location_id', '', { shouldValidate: false });
                    }}
                    disabled={pickersLoading || items.length === 0}
                  >
                    <SelectTrigger
                      id="tx-item"
                      aria-invalid={Boolean(errors.item_id)}
                    >
                      <SelectValue
                        placeholder={pickersLoading ? 'Loading items…' : 'Select item'}
                      />
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
                  {errors.item_id && (
                    <p role="alert" className="text-xs text-danger">
                      {errors.item_id.message}
                    </p>
                  )}
                </div>
              ) : (
                <input type="hidden" value={presetItemId} {...register('item_id')} />
              )}

              <div className="space-y-1.5">
                <Label htmlFor="tx-source">
                  Source — lot @ location <span className="text-danger">*</span>
                </Label>
                <Select
                  value={stockRowKey}
                  onValueChange={(v) => {
                    setValue('stock_row', v, { shouldValidate: true });
                    setValue('to_location_id', '', { shouldValidate: false });
                  }}
                  disabled={!itemId || stockLoading || stockRows.length === 0}
                >
                  <SelectTrigger
                    id="tx-source"
                    aria-invalid={Boolean(errors.stock_row)}
                  >
                    <SelectValue
                      placeholder={
                        !itemId
                          ? 'Pick an item first'
                          : stockLoading
                            ? 'Loading available stock…'
                            : stockRows.length === 0
                              ? 'No stock available for this item'
                              : 'Select lot at source location'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {stockRows.map((r) => (
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

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="tx-dest">
                    Destination <span className="text-danger">*</span>
                  </Label>
                  <Select
                    value={toLocationId}
                    onValueChange={(v) =>
                      setValue('to_location_id', v, { shouldValidate: true })
                    }
                    disabled={!selectedRow || destOptions.length === 0}
                  >
                    <SelectTrigger
                      id="tx-dest"
                      aria-invalid={Boolean(errors.to_location_id)}
                    >
                      <SelectValue
                        placeholder={
                          !selectedRow
                            ? 'Pick source first'
                            : destOptions.length === 0
                              ? 'No other active locations'
                              : 'Select destination'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {destOptions.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          <span className="font-mono text-xs">{l.code}</span>
                          <span className="ml-2 text-text-2">{l.name}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {destCapacity?.hasRacks && (
                    <p
                      className={cn(
                        'text-xs',
                        qtyNum > destCapacity.empty
                          ? 'text-warning'
                          : 'text-text-3',
                      )}
                    >
                      <span className="font-mono">
                        {destCapacity.empty.toLocaleString()}
                      </span>{' '}
                      of{' '}
                      <span className="font-mono">
                        {destCapacity.total.toLocaleString()}
                      </span>{' '}
                      position{destCapacity.total === 1 ? '' : 's'} free
                    </p>
                  )}
                  {errors.to_location_id && (
                    <p role="alert" className="text-xs text-danger">
                      {errors.to_location_id.message}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tx-qty">
                    Units <span className="text-danger">*</span>
                  </Label>
                  <Input
                    id="tx-qty"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step="1"
                    disabled={!selectedRow}
                    aria-invalid={Boolean(errors.qty)}
                    className="font-mono"
                    {...register('qty')}
                  />
                  {selectedRow && (
                    <p className="text-xs text-text-3">
                      Max{' '}
                      <span className="font-mono">
                        {Number(selectedRow.qty_available).toLocaleString()}
                      </span>{' '}
                      at {selectedRow.location_code}
                    </p>
                  )}
                  {errors.qty && (
                    <p role="alert" className="text-xs text-danger">
                      {errors.qty.message}
                    </p>
                  )}
                </div>
              </div>

              {selectedRow && destLoc && validQty && srcBefore !== null && destBefore !== null && (
                <div
                  role="status"
                  aria-live="polite"
                  className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2.5"
                >
                  <p className="mb-1 text-xs text-text-3">
                    After this transfer ·{' '}
                    <span className="font-mono">
                      {selectedRow.lot_number}
                    </span>
                  </p>
                  <div className="grid grid-cols-2 gap-3 font-mono text-sm">
                    <div>
                      <p className="text-xs text-text-3">
                        {selectedRow.location_code}
                      </p>
                      <p className="flex items-baseline gap-2">
                        <span className="text-text-2">
                          {srcBefore.toLocaleString()}
                        </span>
                        <span aria-hidden className="text-text-3">
                          &rarr;
                        </span>
                        <span className="font-semibold text-warning">
                          −{qtyNum.toLocaleString()}
                        </span>
                        <span aria-hidden className="text-text-3">
                          &rarr;
                        </span>
                        <span className="font-semibold text-text-1">
                          {(srcBefore - qtyNum).toLocaleString()}
                        </span>
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-text-3">{destLoc.code}</p>
                      <p className="flex items-baseline gap-2">
                        <span className="text-text-2">
                          {destBefore.toLocaleString()}
                        </span>
                        <span aria-hidden className="text-text-3">
                          &rarr;
                        </span>
                        <span className="font-semibold text-success">
                          +{qtyNum.toLocaleString()}
                        </span>
                        <span aria-hidden className="text-text-3">
                          &rarr;
                        </span>
                        <span className="font-semibold text-text-1">
                          {(destBefore + qtyNum).toLocaleString()}
                        </span>
                      </p>
                    </div>
                  </div>
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
                disabled={submitting || !selectedRow || !toLocationId}
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
        action="movement.transfer"
        meaning={attestation}
        onConfirmed={submit}
        title="Sign this transfer"
        submitLabel="Sign & record"
      />
    </>
  );
}
