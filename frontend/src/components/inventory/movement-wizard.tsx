'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpFromLine,
  Loader2,
  ShieldCheck,
} from 'lucide-react';

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
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { cn } from '@/lib/utils';

import { itemsApi, type ApiItem } from '@/lib/api/items';
import { locationsApi, type Location } from '@/lib/api/locations';
import { lotsApi, type Lot } from '@/lib/api/lots';
import {
  movementsApi,
  type DispenseInput,
  type ReceiptInput,
  type StockByLotEntry,
} from '@/lib/api/movements';
import {
  storageApi,
  buildCapacityMap,
  type LocationCapacity,
} from '@/lib/api/storage';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';

export type MovementDirection = 'in' | 'out';

const NEW_LOT = '__new__';

const schema = z
  .object({
    direction: z.enum(['in', 'out']),
    item_id: z.string().uuid('Pick an item'),
    location_id: z.string().uuid('Pick a location'),
    qty: z.coerce
      .number()
      .int('Units must be a whole number')
      .positive('Units must be > 0')
      .max(5000, 'Max 5000 units'),
    lot_choice: z.string().min(1, 'Pick a lot'),
    // Inline-lot fields (only required when direction='in' && lot_choice === NEW_LOT):
    lot_number: z.string().optional(),
    expiration_date: z.string().optional(),
    manufacture_date: z.string().optional(),
    // Free-text "where did it go" — required on OUT (validated below).
    destination: z.string().max(256).optional(),
    // Carried only so the OUT branch can validate qty against availability.
    available_qty: z.number().optional(),
    // Carried only so the IN branch can validate qty against the location's
    // free rack positions. ``undefined`` for ledger-only (rack-less) locations,
    // which the backend places without a position cap.
    empty_positions: z.number().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.direction === 'in') {
      // Mirror the backend's not_enough_empty_positions guard so the operator
      // sees the limit in Step 1 instead of after signing in Step 2.
      if (v.empty_positions !== undefined && v.qty > v.empty_positions) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['qty'],
          message:
            `Location has only ${v.empty_positions} empty position(s); ` +
            `cannot place ${v.qty} unit(s). Add a rack or pick another location.`,
        });
      }
      if (v.lot_choice === NEW_LOT) {
        if (!v.lot_number || v.lot_number.trim().length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['lot_number'],
            message: 'Lot number is required for a new lot',
          });
        }
        if (
          v.expiration_date &&
          v.manufacture_date &&
          v.expiration_date < v.manufacture_date
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['expiration_date'],
            message: 'Expiration must be on or after manufacture date',
          });
        }
      }
    } else {
      // OUT: lot must be an existing UUID, never NEW_LOT.
      if (v.lot_choice === NEW_LOT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lot_choice'],
          message: 'You can only dispense from an existing lot',
        });
      }
      // qty must not exceed available (when we know the availability).
      if (
        v.available_qty !== undefined &&
        v.qty > v.available_qty
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['qty'],
          message: `Only ${v.available_qty} available at this lot/location`,
        });
      }
      // Destination is required on a unit-out.
      if (!v.destination || v.destination.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['destination'],
          message: 'Destination is required',
        });
      }
    }
  });

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional pre-selection so the wizard on the detail page skips the picker. */
  presetItemId?: string;
  /**
   * Default direction at open. When omitted: ``'in'`` if no preset,
   * else inferred from the preset item's qty_on_hand (positive →
   * ``'out'``, zero → ``'in'``).
   */
  defaultDirection?: MovementDirection;
  /** Called after the movement commits so the parent can refetch. */
  onCompleted?: () => void;
}

type Step = 'form' | 'review';

/**
 * Unified stock movement wizard. Operator first picks direction
 * (Unit in = receipt, Unit out = dispense); the form below adapts
 * to the chosen direction:
 *
 *   * IN  — lot can be existing or created inline; no qty cap.
 *   * OUT — lot must exist with stock at the chosen location, and
 *           qty cannot exceed the lot/location balance.
 *
 * Direction defaults: if the parent passes ``defaultDirection`` that
 * wins; otherwise OUT when there is positive stock to pull from,
 * else IN. The auto-switch also fires once when the operator picks
 * an item from the list view, unless they've manually flipped the
 * toggle first.
 */
export function MovementWizard({
  open,
  onOpenChange,
  presetItemId,
  defaultDirection,
  onCompleted,
}: Props) {
  const [step, setStep] = React.useState<Step>('form');
  const [pickersLoading, setPickersLoading] = React.useState(false);
  const [pickersError, setPickersError] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<ApiItem[]>([]);
  const [locations, setLocations] = React.useState<Location[]>([]);
  // Per-location rack capacity, keyed by location id. Locations absent from the
  // map are ledger-only (no racks) and have no position cap. Drives the Step 1
  // free-positions preview and the qty guard for unit-in.
  const [capacityByLoc, setCapacityByLoc] = React.useState<
    Map<string, LocationCapacity>
  >(new Map());
  // Lot list when direction=in (every lot, regardless of balance).
  const [lotsIn, setLotsIn] = React.useState<Lot[]>([]);
  // Per-(lot, location) balances. Always fetched — with zero rows
  // included — so the impact preview can read the current balance
  // for IN flows too. The OUT picker filters to qty > 0 at render time.
  const [stockByLot, setStockByLot] = React.useState<StockByLotEntry[]>([]);
  const [lotsLoading, setLotsLoading] = React.useState(false);
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
      direction: defaultDirection ?? 'in',
      item_id: presetItemId ?? '',
      location_id: '',
      qty: 1,
      lot_choice: '',
      lot_number: '',
      expiration_date: '',
      manufacture_date: '',
      destination: '',
    },
  });

  const direction = watch('direction');
  const itemId = watch('item_id');
  const locationId = watch('location_id');
  const lotChoice = watch('lot_choice');
  const qty = watch('qty');

  // ── Pickers: items + locations once when the dialog opens ─────────────
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
      // Storage tree is optional context — a failure here must not block the
      // wizard, so swallow errors and fall back to "no capacity known".
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

  // The wizard always opens on "Unit in" — the form default. The operator
  // flips to "Unit out" with the toggle when dispensing. We deliberately do
  // NOT auto-switch to "out" based on the item's stock: operators expect a
  // fresh unit-in by default, and the auto-switch was surprising. A caller can
  // still force a starting side via the ``defaultDirection`` prop.

  // ── Lot data: scoped to the chosen item ──────────────────────────────
  //
  // Both lists fire in parallel any time the item changes. The IN
  // picker uses ``lotsIn`` (all released/quarantined lots), the OUT
  // picker filters ``stockByLot`` to qty > 0 at render time, and the
  // impact preview at the bottom of the form reads ``stockByLot`` to
  // compute the "before" balance for either direction.
  React.useEffect(() => {
    if (!open || !itemId) {
      setLotsIn([]);
      setStockByLot([]);
      return;
    }
    const ctrl = new AbortController();
    setLotsLoading(true);
    Promise.all([
      lotsApi.listForItem(itemId, { signal: ctrl.signal }),
      movementsApi.stockByLot(
        itemId,
        { includeEmpty: true },
        { signal: ctrl.signal },
      ),
    ])
      .then(([lots, stock]) => {
        setLotsIn(lots);
        setStockByLot(stock);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLotsIn([]);
        setStockByLot([]);
      })
      .finally(() => setLotsLoading(false));

    return () => ctrl.abort();
  }, [open, itemId]);

  // Reset everything when the dialog closes.
  React.useEffect(() => {
    if (!open) {
      reset();
      setStep('form');
      setSubmitError(null);
      setShowReauth(false);
      setSubmitting(false);
    }
  }, [open, reset]);

  // Find the (lot, location) row picked in OUT mode so we can show
  // "X of Y available" and feed the qty validator.
  const selectedStockRow: StockByLotEntry | null = React.useMemo(() => {
    if (direction === 'in') return null;
    if (!lotChoice) return null;
    return (
      stockByLot.find(
        (r) =>
          r.lot_id === lotChoice &&
          (locationId ? r.location_id === locationId : true),
      ) ?? null
    );
  }, [direction, lotChoice, locationId, stockByLot]);

  // Keep available_qty (used by the schema) in sync with the selection.
  React.useEffect(() => {
    if (direction !== 'in' && selectedStockRow) {
      setValue('available_qty', Number(selectedStockRow.qty_available), {
        shouldValidate: false,
      });
    } else {
      setValue('available_qty', undefined, { shouldValidate: false });
    }
  }, [direction, selectedStockRow, setValue]);

  // Rack capacity for the location chosen in IN mode. Null when nothing is
  // picked or the location is ledger-only (no racks → no position cap).
  const selectedLocationCapacity: LocationCapacity | null = React.useMemo(() => {
    if (direction !== 'in' || !locationId) return null;
    return capacityByLoc.get(locationId) ?? null;
  }, [direction, locationId, capacityByLoc]);

  // Keep empty_positions (used by the schema's IN guard) in sync. Only
  // rack-backed locations cap the qty; ledger-only locations clear it so the
  // operator isn't blocked. Validate on change so the limit surfaces live.
  React.useEffect(() => {
    if (selectedLocationCapacity?.hasRacks) {
      setValue('empty_positions', selectedLocationCapacity.empty, {
        shouldValidate: true,
      });
    } else {
      setValue('empty_positions', undefined, { shouldValidate: false });
    }
  }, [selectedLocationCapacity, setValue]);

  // ── Direction toggle ──────────────────────────────────────────────────
  const flipDirection = (next: MovementDirection): void => {
    setValue('direction', next, { shouldValidate: false });
    // Reset lot choice — IN lot list and OUT stock-by-lot list are
    // different shapes, so the existing selection wouldn't make sense.
    setValue('lot_choice', '', { shouldValidate: false });
    setValue('lot_number', '', { shouldValidate: false });
  };

  // ── Step transitions ──────────────────────────────────────────────────
  const goToReview = (_values: FormValues): void => {
    setStep('review');
    setSubmitError(null);
  };

  // ── Commit after the user signs ───────────────────────────────────────
  const submitMovement = async (evidence: ReauthResponse): Promise<void> => {
    const v = getValues();
    setSubmitting(true);
    setSubmitError(null);
    try {
      let created;
      if (v.direction === 'in') {
        const payload: ReceiptInput = {
          item_id: v.item_id,
          location_id: v.location_id,
          qty: Number(v.qty),
          evidence_id: evidence.evidence_id,
          ...(v.lot_choice === NEW_LOT
            ? {
                new_lot: {
                  lot_number: (v.lot_number ?? '').trim(),
                  expiration_date: v.expiration_date || null,
                  manufacture_date: v.manufacture_date || null,
                },
              }
            : { lot_id: v.lot_choice }),
        };
        created = await movementsApi.receipt(payload);
        toast.success('Unit in recorded', {
          description: `${created.item_number} · +${created.qty_abs} into ${
            created.to_location_code ?? '—'
          }`,
        });
      } else {
        const payload: DispenseInput = {
          item_id: v.item_id,
          location_id: v.location_id,
          lot_id: v.lot_choice,
          qty: Number(v.qty),
          destination: (v.destination ?? '').trim(),
          evidence_id: evidence.evidence_id,
        };
        created = await movementsApi.dispense(payload);
        toast.success('Unit out recorded', {
          description: `${created.item_number} · −${created.qty_abs} from ${
            created.from_location_code ?? '—'
          }`,
        });
      }
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
        } else if (err.code === 'lot_number_conflict') {
          setSubmitError(
            'That lot number already exists for this item. Pick the existing lot instead.',
          );
        } else if (
          err.code === 'dispense_exceeds_available' ||
          err.code === 'discard_exceeds_available'
        ) {
          setSubmitError(err.message);
        } else {
          setSubmitError(err.message);
        }
      } else {
        setSubmitError('Failed to record movement. Please try again.');
      }
      setStep('review');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Convenience views for the Review step ─────────────────────────────
  const chosenItem = items.find((i) => i.id === itemId) ?? null;
  const chosenLocation = locations.find((l) => l.id === locationId) ?? null;
  const chosenLotIn = lotsIn.find((l) => l.id === lotChoice) ?? null;
  const isIn = direction === 'in';

  // The effective movement type the backend writes. Unit-out is always a
  // dispense now (the discard reason-routing was removed with the Reason
  // field). Drives the e-sign action verb + attestation wording.
  const effectiveType: 'receipt' | 'dispense' = isIn ? 'receipt' : 'dispense';

  const action = `movement.${effectiveType}`;
  const itemDesc = chosenItem?.description ?? chosenItem?.item_number ?? 'item';
  const locDesc =
    chosenLocation?.code ?? selectedStockRow?.location_code ?? '—';
  const attestation = isIn
    ? `I attest this unit-in of ${qty} unit(s) of ${itemDesc} into ${locDesc} is accurate.`
    : `I attest this unit-out of ${qty} unit(s) of ${itemDesc} from ${locDesc} is accurate.`;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <form onSubmit={handleSubmit(goToReview)}>
            <DialogHeader>
              <DialogTitle>
                {isIn ? 'Record unit in' : 'Record unit out'}
                <span className="ml-2 text-xs font-normal text-text-3">
                  Step {step === 'form' ? '1' : '2'} of 2
                </span>
              </DialogTitle>
              <DialogDescription>
                {isIn
                  ? 'Vendor → inventory. A new ledger row is written under your e-signature; units are placed into the location’s racks.'
                  : 'Inventory → consumed. A new ledger row is written under your e-signature; the units are freed from their racks.'}
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-4">
              {/* Direction toggle — top of every step so context is clear. */}
              <DirectionToggle
                value={direction}
                onChange={flipDirection}
                disabled={step !== 'form'}
              />

              {pickersError && (
                <p
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
                >
                  {pickersError}
                </p>
              )}

              {step === 'form' ? (
                <FormStep
                  presetItemId={presetItemId}
                  items={items}
                  locations={locations}
                  lotsIn={lotsIn}
                  lotsLoading={lotsLoading}
                  stockByLot={stockByLot}
                  selectedStockRow={selectedStockRow}
                  selectedLocationCapacity={selectedLocationCapacity}
                  pickersLoading={pickersLoading}
                  register={register}
                  setValue={setValue}
                  watchValues={{
                    direction,
                    itemId,
                    locationId,
                    lotChoice,
                    qty,
                  }}
                  errors={errors}
                />
              ) : (
                <ReviewStep
                  direction={direction}
                  item={chosenItem}
                  location={chosenLocation}
                  lotIn={chosenLotIn}
                  stockRow={selectedStockRow}
                  formValues={getValues()}
                />
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
              {step === 'review' && (
                <Button
                  type="button"
                  onClick={() => setStep('form')}
                  disabled={submitting}
                >
                  <ArrowLeft size={14} /> Back
                </Button>
              )}
              <Button
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              {step === 'form' ? (
                <Button type="submit" variant="primary">
                  Review <ArrowRight size={14} />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => setShowReauth(true)}
                  disabled={submitting}
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
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action={action}
        meaning={attestation}
        onConfirmed={submitMovement}
        title={isIn ? 'Sign this unit in' : 'Sign this unit out'}
        submitLabel="Sign & record"
      />
    </>
  );
}

// ── Direction toggle ────────────────────────────────────────────────────

function DirectionToggle({
  value,
  onChange,
  disabled,
}: {
  value: MovementDirection;
  onChange: (next: MovementDirection) => void;
  disabled?: boolean;
}) {
  const options = [
    {
      v: 'in' as const,
      label: 'Unit in',
      hint: 'Add to inventory',
      Icon: ArrowDownToLine,
      activeColor: 'border-success bg-success/5',
    },
    {
      v: 'out' as const,
      label: 'Unit out',
      hint: 'Consume / remove',
      Icon: ArrowUpFromLine,
      activeColor: 'border-warning bg-warning/5',
    },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Unit movement direction"
      className="grid grid-cols-2 gap-2"
    >
      {options.map(({ v, label, hint, Icon, activeColor }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(v)}
            className={cn(
              'flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              disabled && 'pointer-events-none opacity-60',
              active
                ? `${activeColor} text-text-1`
                : 'border-border bg-surface text-text-2 hover:text-text-1',
            )}
          >
            <span className="flex items-center gap-2 font-medium">
              <Icon size={14} aria-hidden /> {label}
            </span>
            <span className="text-xs text-text-3">{hint}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Step 1: form ────────────────────────────────────────────────────────

interface FormStepProps {
  presetItemId?: string;
  items: ApiItem[];
  locations: Location[];
  lotsIn: Lot[];
  lotsLoading: boolean;
  stockByLot: StockByLotEntry[];
  selectedStockRow: StockByLotEntry | null;
  selectedLocationCapacity: LocationCapacity | null;
  pickersLoading: boolean;
  register: ReturnType<typeof useForm<FormValues>>['register'];
  setValue: ReturnType<typeof useForm<FormValues>>['setValue'];
  watchValues: {
    direction: MovementDirection;
    itemId: string;
    locationId: string;
    lotChoice: string;
    qty: number;
  };
  errors: ReturnType<typeof useForm<FormValues>>['formState']['errors'];
}

function FormStep({
  presetItemId,
  items,
  locations,
  lotsIn,
  lotsLoading,
  stockByLot,
  selectedStockRow,
  selectedLocationCapacity,
  pickersLoading,
  register,
  setValue,
  watchValues,
  errors,
}: FormStepProps) {
  const { direction, itemId, locationId, lotChoice, qty } = watchValues;
  const isIn = direction === 'in';
  const isOut = direction === 'out';
  const isNewLot = isIn && lotChoice === NEW_LOT;
  // OUT picker source — only rows with a positive balance.
  const outRows = React.useMemo(
    () => stockByLot.filter((r) => Number(r.qty_available) > 0),
    [stockByLot],
  );

  // ── Impact preview (Before → Δ → After) ──────────────────────────────
  // For OUT: ``selectedStockRow.qty_available`` is the canonical "before".
  // For IN: look up the (lot, location) balance in ``stockByLot`` if both
  // are picked, otherwise 0 (new lot, or first stock at this location).
  const qtyNum = Number(qty);
  const previewBefore: number | null = React.useMemo(() => {
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) return null;
    if (!isIn) {
      return selectedStockRow ? Number(selectedStockRow.qty_available) : null;
    }
    if (!locationId) return null;
    if (lotChoice === NEW_LOT) return 0;
    if (!lotChoice) return null;
    const row = stockByLot.find(
      (r) => r.lot_id === lotChoice && r.location_id === locationId,
    );
    return row ? Number(row.qty_available) : 0;
  }, [isIn, qtyNum, locationId, lotChoice, selectedStockRow, stockByLot]);

  const previewLotLabel: string = React.useMemo(() => {
    if (!isIn) return selectedStockRow?.lot_number ?? '';
    if (lotChoice === NEW_LOT) return 'new lot';
    return lotsIn.find((l) => l.id === lotChoice)?.lot_number ?? '';
  }, [isIn, selectedStockRow, lotChoice, lotsIn]);
  const previewLocationLabel: string = React.useMemo(() => {
    if (!isIn) return selectedStockRow?.location_code ?? '';
    return locations.find((l) => l.id === locationId)?.code ?? '';
  }, [isIn, selectedStockRow, locationId, locations]);

  // For OUT, picking the lot row also pins the location (since
  // stock-by-lot rows are scoped per location).
  const pickStockRow = (row: StockByLotEntry): void => {
    setValue('lot_choice', row.lot_id, { shouldValidate: true });
    setValue('location_id', row.location_id, { shouldValidate: true });
  };

  return (
    <>
      {/* Item — hidden when the wizard was opened with a preset (detail page). */}
      {presetItemId ? (
        <input type="hidden" value={presetItemId} {...register('item_id')} />
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="mv-item">
            Item <span className="text-danger">*</span>
          </Label>
          <Select
            value={itemId}
            onValueChange={(v) => setValue('item_id', v, { shouldValidate: true })}
            disabled={pickersLoading || items.length === 0}
          >
            <SelectTrigger id="mv-item" aria-invalid={Boolean(errors.item_id)}>
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
      )}

      {/* OUT + Adjustment share the same lot-at-location picker. */}
      {!isIn ? (
        <div className="space-y-1.5">
          <Label htmlFor="mv-stockrow">
            Lot & location <span className="text-danger">*</span>
          </Label>
          <Select
            value={lotChoice && locationId ? `${lotChoice}|${locationId}` : ''}
            onValueChange={(v) => {
              const [lid, loc] = v.split('|');
              const row = outRows.find(
                (r) => r.lot_id === lid && r.location_id === loc,
              );
              if (row) pickStockRow(row);
            }}
            disabled={!itemId || lotsLoading}
          >
            <SelectTrigger
              id="mv-stockrow"
              aria-invalid={Boolean(errors.lot_choice || errors.location_id)}
            >
              <SelectValue
                placeholder={
                  !itemId
                    ? 'Pick an item first'
                    : lotsLoading
                      ? 'Loading available stock…'
                      : outRows.length === 0
                        ? 'No stock available for this item'
                        : 'Select lot at location'
                }
              />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {outRows.map((r) => (
                <SelectItem
                  key={`${r.lot_id}|${r.location_id}`}
                  value={`${r.lot_id}|${r.location_id}`}
                >
                  <span className="font-mono text-xs">{r.lot_number}</span>
                  <span className="ml-2 text-text-2">@ {r.location_code}</span>
                  <span className="ml-2 text-text-3">
                    {Number(r.qty_available).toLocaleString()} avail
                  </span>
                  {r.expiration_date && (
                    <span className="ml-2 text-text-3">
                      · exp {r.expiration_date}
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(errors.lot_choice || errors.location_id) && (
            <p role="alert" className="text-xs text-danger">
              {errors.lot_choice?.message ?? errors.location_id?.message}
            </p>
          )}
        </div>
      ) : (
        // IN mode: location + qty side-by-side, lot picker below.
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="mv-loc">
              Location <span className="text-danger">*</span>
            </Label>
            <Select
              value={locationId}
              onValueChange={(v) =>
                setValue('location_id', v, { shouldValidate: true })
              }
              disabled={pickersLoading || locations.length === 0}
            >
              <SelectTrigger
                id="mv-loc"
                aria-invalid={Boolean(errors.location_id)}
              >
                <SelectValue
                  placeholder={pickersLoading ? 'Loading…' : 'Select location'}
                />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    <span className="font-mono text-xs">{l.code}</span>
                    <span className="ml-2 text-text-2">{l.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.location_id && (
              <p role="alert" className="text-xs text-danger">
                {errors.location_id.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mv-qty">
              Units <span className="text-danger">*</span>
            </Label>
            <Input
              id="mv-qty"
              type="number"
              inputMode="numeric"
              min={0}
              max={5000}
              step="1"
              aria-invalid={Boolean(errors.qty)}
              {...register('qty')}
            />
            {selectedLocationCapacity?.hasRacks && (
              <p
                className={cn(
                  'text-xs',
                  qtyNum > selectedLocationCapacity.empty
                    ? 'text-warning'
                    : 'text-text-3',
                )}
              >
                <span className="font-mono">
                  {selectedLocationCapacity.empty.toLocaleString()}
                </span>{' '}
                of{' '}
                <span className="font-mono">
                  {selectedLocationCapacity.total.toLocaleString()}
                </span>{' '}
                position{selectedLocationCapacity.total === 1 ? '' : 's'} free
              </p>
            )}
            {errors.qty && (
              <p role="alert" className="text-xs text-danger">
                {errors.qty.message}
              </p>
            )}
          </div>
        </div>
      )}

      {/* OUT mode: qty input + live "X of Y available" hint */}
      {isOut && (
        <div className="space-y-1.5">
          <Label htmlFor="mv-qty-out">
            Units <span className="text-danger">*</span>
          </Label>
          <Input
            id="mv-qty-out"
            type="number"
            inputMode="numeric"
            min={0}
            max={5000}
            step="1"
            disabled={!selectedStockRow}
            aria-invalid={Boolean(errors.qty)}
            {...register('qty')}
          />
          {selectedStockRow && (
            <p className="text-xs text-text-3">
              {Number(watchValues.qty || 0).toLocaleString()} of{' '}
              <span className="font-mono">
                {Number(selectedStockRow.qty_available).toLocaleString()}
              </span>{' '}
              available at {selectedStockRow.location_code}
            </p>
          )}
          {errors.qty && (
            <p role="alert" className="text-xs text-danger">
              {errors.qty.message}
            </p>
          )}
        </div>
      )}

      {/* OUT mode: where the units go (free text, required) */}
      {isOut && (
        <div className="space-y-1.5">
          <Label htmlFor="mv-dest">
            Destination <span className="text-danger">*</span>
          </Label>
          <Input
            id="mv-dest"
            placeholder="e.g. PD Lab, Patient 123, Shipment SH-001"
            aria-invalid={Boolean(errors.destination)}
            {...register('destination')}
          />
          {errors.destination && (
            <p role="alert" className="text-xs text-danger">
              {errors.destination.message}
            </p>
          )}
        </div>
      )}

      {/* IN mode: lot picker (existing or new) */}
      {isIn && (
        <div className="space-y-1.5">
          <Label htmlFor="mv-lot">
            Lot <span className="text-danger">*</span>
          </Label>
          <Select
            value={lotChoice}
            onValueChange={(v) => setValue('lot_choice', v, { shouldValidate: true })}
            disabled={!itemId || lotsLoading}
          >
            <SelectTrigger id="mv-lot" aria-invalid={Boolean(errors.lot_choice)}>
              <SelectValue
                placeholder={
                  !itemId
                    ? 'Pick an item first'
                    : lotsLoading
                      ? 'Loading lots…'
                      : 'Select lot or create new'
                }
              />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value={NEW_LOT}>+ New lot from this delivery</SelectItem>
              {lotsIn.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  <span className="font-mono text-xs">{l.lot_number}</span>
                  {l.expiration_date && (
                    <span className="ml-2 text-text-3">exp {l.expiration_date}</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.lot_choice && (
            <p role="alert" className="text-xs text-danger">
              {errors.lot_choice.message}
            </p>
          )}
        </div>
      )}

      {isNewLot && (
        <>
          <Separator />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="mv-lot-num">
                New lot number <span className="text-danger">*</span>
              </Label>
              <Input
                id="mv-lot-num"
                placeholder="L-20260601-A"
                className="font-mono"
                aria-invalid={Boolean(errors.lot_number)}
                {...register('lot_number')}
              />
              {errors.lot_number && (
                <p role="alert" className="text-xs text-danger">
                  {errors.lot_number.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mv-lot-mfg">Manufacture date</Label>
              <Input
                id="mv-lot-mfg"
                type="date"
                {...register('manufacture_date')}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mv-lot-exp">Expiration date</Label>
            <Input
              id="mv-lot-exp"
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
        </>
      )}

      {previewBefore !== null && (() => {
        const signedDelta = isIn ? qtyNum : -qtyNum;
        return (
          <ImpactPreview
            before={previewBefore}
            delta={signedDelta}
            after={previewBefore + signedDelta}
            lotLabel={previewLotLabel}
            locationLabel={previewLocationLabel}
          />
        );
      })()}
    </>
  );
}

// ── Impact preview strip ────────────────────────────────────────────────

function ImpactPreview({
  before,
  delta,
  after,
  lotLabel,
  locationLabel,
}: {
  before: number;
  delta: number;
  after: number;
  lotLabel: string;
  locationLabel: string;
}) {
  const fmt = (n: number): string => n.toLocaleString();
  const ctx =
    lotLabel && locationLabel
      ? `${lotLabel} @ ${locationLabel}`
      : lotLabel || locationLabel || 'this lot & location';
  const positive = delta >= 0;
  const borderClass = positive
    ? 'border-success/30 bg-success/5'
    : 'border-warning/30 bg-warning/5';
  const deltaClass = positive
    ? 'text-success font-semibold'
    : 'text-warning font-semibold';
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'rounded-md border px-3 py-2.5',
        borderClass,
      )}
    >
      <p className="mb-1 text-xs text-text-3">
        After this movement &middot; <span className="font-mono">{ctx}</span>
      </p>
      <p className="flex items-baseline gap-2 font-mono text-sm">
        <span className="text-text-2">{fmt(before)}</span>
        <span aria-hidden className="text-text-3">
          &rarr;
        </span>
        <span className={deltaClass}>
          {positive ? '+' : '−'}
          {fmt(Math.abs(delta))}
        </span>
        <span aria-hidden className="text-text-3">
          &rarr;
        </span>
        <span className="font-semibold text-text-1">{fmt(after)}</span>
      </p>
    </div>
  );
}

// ── Step 2: review ──────────────────────────────────────────────────────

function ReviewStep({
  direction,
  item,
  location,
  lotIn,
  stockRow,
  formValues,
}: {
  direction: MovementDirection;
  item: ApiItem | null;
  location: Location | null;
  lotIn: Lot | null;
  stockRow: StockByLotEntry | null;
  formValues: FormValues;
}) {
  const isIn = direction === 'in';
  const isNewLot = isIn && formValues.lot_choice === NEW_LOT;
  const signedQty = isIn ? formValues.qty : -formValues.qty;

  return (
    <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2.5 text-sm">
      <KV label="Item">
        {item ? (
          <>
            <span className="font-mono text-xs text-accent">{item.item_number}</span>
            <span className="ml-2">{item.description}</span>
          </>
        ) : (
          'Pre-selected item'
        )}
      </KV>
      <KV label={isIn ? 'To location' : 'From location'}>
        {location ? (
          <>
            <span className="font-mono text-xs">{location.code}</span>
            <span className="ml-2 text-text-2">{location.name}</span>
          </>
        ) : stockRow ? (
          <>
            <span className="font-mono text-xs">{stockRow.location_code}</span>
            <span className="ml-2 text-text-2">{stockRow.location_name}</span>
          </>
        ) : (
          '—'
        )}
      </KV>
      <KV label="Lot">
        {isNewLot ? (
          <>
            <span className="font-mono text-xs">{formValues.lot_number}</span>
            <span className="ml-2 text-text-3">(new)</span>
          </>
        ) : lotIn ? (
          <span className="font-mono text-xs">{lotIn.lot_number}</span>
        ) : stockRow ? (
          <span className="font-mono text-xs">{stockRow.lot_number}</span>
        ) : (
          '—'
        )}
      </KV>
      {isNewLot && formValues.expiration_date && (
        <KV label="Expires">{formValues.expiration_date}</KV>
      )}
      <KV label="Units">
        <span
          className={cn(
            'font-mono',
            signedQty >= 0 ? 'text-success' : 'text-warning',
          )}
        >
          {signedQty >= 0 ? '+' : '−'}
          {Math.abs(signedQty)}
        </span>
        {!isIn && stockRow && (
          <span className="ml-2 text-xs text-text-3">
            (of {Number(stockRow.qty_available).toLocaleString()} avail)
          </span>
        )}
      </KV>
      {!isIn && formValues.destination && (
        <KV label="Destination">{formValues.destination}</KV>
      )}
    </dl>
  );
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs text-text-3">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </>
  );
}
