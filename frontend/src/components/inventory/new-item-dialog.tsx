'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

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
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { useInventoryStore } from '@/stores/inventory.store';
import { ApiError } from '@/lib/api/client';
import { suppliersApi, type Supplier } from '@/lib/api/suppliers';
import {
  tiersApi,
  isBuiltTier,
  TIER_TYPE_LABELS,
  type ApiTier,
} from '@/lib/api/tiers';

import { SupplierMultiSelect } from './supplier-multi-select';

/** Strip a re-typed tier prefix off the SKU tail (so "CR-001" → "001",
 *  not "CR-CR-001"). Prefixes are alphanumeric, safe to inline in the regex. */
function skuTail(prefix: string, raw: string): string {
  return raw.trim().replace(new RegExp(`^${prefix}-?`, 'i'), '');
}

// ── Form schema ────────────────────────────────────────────────────────

const schema = z.object({
  // Free-form item number — any non-blank code the operator issues
  // (e.g. CM-0001, CM-0001A, REF-017). Per docs/modules/inventory.md §3.1
  // the only backend rule is uniqueness, so we just trim, require non-blank
  // and cap the length to match the server contract.
  itemId: z
    .string()
    .trim()
    .min(1, 'Item # is required')
    .max(64, 'Item # must be at most 64 characters'),
  desc: z.string().min(3, 'Description is required'),
  // Required tier — governs whether the item is a Product (built) or
  // Purchased, and thus BOM eligibility.
  tierId: z.string().min(1, 'Tier is required'),
  // Free-text unit of measure (each, mL, box …). Optional.
  uom: z.string().trim().max(32, 'Unit is too long').optional().default(''),
  // Blind-consumed, no per-lot traceability.
  isConsumable: z.boolean().default(false),
  // Assigned suppliers — zero-or-more. The only suppliers this item can later be
  // received against. Optional: an item may start with none and add later.
  supplierIds: z.array(z.string()).default([]),
  leadDays: z.coerce.number().int().nonnegative('Must be ≥ 0'),
  threshold: z.coerce.number().int().nonnegative('Must be ≥ 0'),
  nearExpiryThresholdDays: z.coerce
    .number()
    .int()
    .nonnegative('Must be ≥ 0')
    .max(3650, 'Must be ≤ 3650'),
});

type Values = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create (in addition to the toast). Lets a
   *  host list refresh itself — the inventory list relies on the store
   *  refetch instead and omits this. */
  onCreated?: () => void;
  /** When set, the tier is fixed to this one and the picker is read-only.
   *  Used by the per-tier sections (e.g. Raw Materials) where the tier is
   *  implied by the page, not chosen by the operator. */
  lockedTier?: ApiTier | null;
  /** Dialog title override (defaults to "New inventory item"). */
  title?: string;
  /** Short line under the title (e.g. the SKU-prefix hint on a tier page). */
  description?: React.ReactNode;
  /** Submit-button label override (defaults to "Create item"). */
  submitLabel?: string;
  /** Success-toast headline (e.g. "Sub-assembly created"). Defaults to the
   *  generic "Item created". */
  createdLabel?: string;
}

export function NewItemDialog({
  open,
  onOpenChange,
  onCreated,
  lockedTier,
  title,
  description,
  submitLabel,
  createdLabel,
}: Props) {
  // Store actions — the only thing this component does for I/O.
  const createItem = useInventoryStore((s) => s.create);
  const createPending = useInventoryStore((s) => s.createPending);

  // Supplier dropdown source. Loaded once when the dialog opens — the
  // master-data list is small (≤ ~100 rows) and changes rarely, so a
  // simple on-open fetch beats wiring it into the store.
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [suppliersLoading, setSuppliersLoading] = React.useState(false);
  const [suppliersError, setSuppliersError] = React.useState<string | null>(null);

  const [tiers, setTiers] = React.useState<ApiTier[]>([]);

  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      itemId: '',
      desc: '',
      tierId: lockedTier?.id ?? '',
      uom: '',
      isConsumable: false,
      supplierIds: [],
      leadDays: 0,
      threshold: 0,
      nearExpiryThresholdDays: 30,
    },
  });

  const supplierIds = watch('supplierIds');
  const tierId = watch('tierId');
  const isConsumable = watch('isConsumable');
  const itemId = watch('itemId');

  // When the tier is locked (e.g. Raw Materials), the SKU is always
  // prefixed with the tier prefix; the operator only types the tail.
  const skuPrefix = lockedTier?.prefix ?? '';
  const fullSku = lockedTier
    ? `${skuPrefix}-${skuTail(skuPrefix, itemId)}`
    : itemId;

  // Supplier-side fields only apply to Purchased tiers — a built item
  // (AY/FG) is manufactured, not bought, so it has no supplier and no supplier
  // lead time (REQ-2026-07-01-INV-002; per-supplier lead time is future state
  // per REQ-2026-07-09-PLN-006). The consumable flag is likewise CR-only —
  // Transaction Spec §1.1: "A CR item may be designated as either a raw
  // material or a consumable."
  //
  // Reorder + near-expiry are NOT supplier fields and stay on every tier:
  // planning nets sub-assemblies against on-hand (REQ-2026-07-09-PLN-002), and
  // finished goods carry a tracked, flagged expiration (REQ-2026-07-01-INV-008,
  // Transaction Spec §3.1).
  const selectedTier =
    lockedTier ?? tiers.find((c) => c.id === tierId);
  const showPurchasing = selectedTier?.type === 'raw_material';

  // ── Side effects ─────────────────────────────────────────────────────

  // Load suppliers once when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setSuppliersLoading(true);
    setSuppliersError(null);
    suppliersApi
      .list({ activeOnly: true, signal: ctrl.signal })
      .then((rows) => setSuppliers(rows))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setSuppliersError(
          err instanceof ApiError ? err.message : 'Failed to load suppliers.',
        );
      })
      .finally(() => setSuppliersLoading(false));
    return () => ctrl.abort();
  }, [open]);

  // Load tiers once when the dialog opens — skipped when the tier is
  // fixed by the host page (no picker to populate).
  React.useEffect(() => {
    if (!open || lockedTier) return;
    const ctrl = new AbortController();
    tiersApi
      .list({ signal: ctrl.signal })
      .then(setTiers)
      .catch(() => {
        /* surfaced via the empty dropdown */
      });
    return () => ctrl.abort();
  }, [open, lockedTier]);

  // Keep the locked tier selected while the dialog is open.
  React.useEffect(() => {
    if (open && lockedTier) {
      setValue('tierId', lockedTier.id, { shouldValidate: true });
    }
  }, [open, lockedTier, setValue]);

  // Reset the form when the dialog closes.
  React.useEffect(() => {
    if (!open) {
      reset({
        itemId: '',
        desc: '',
        tierId: lockedTier?.id ?? '',
        uom: '',
        isConsumable: false,
        supplierIds: [],
        leadDays: 0,
        threshold: 0,
        nearExpiryThresholdDays: 30,
      });
      setSubmitError(null);
    }
  }, [open, reset, lockedTier]);

  // ── Submit ───────────────────────────────────────────────────────────

  const onSubmit = async (data: Values): Promise<void> => {
    setSubmitError(null);
    try {
      const created = await createItem({
        item_number: lockedTier
          ? `${skuPrefix}-${skuTail(skuPrefix, data.itemId)}`
          : data.itemId,
        description: data.desc,
        tier_id: data.tierId,
        uom: data.uom ? data.uom : null,
        is_consumable: data.isConsumable,
        supplier_ids: data.supplierIds,
        avg_lead_days: data.leadDays,
        reorder_threshold: data.threshold,
        near_expiry_threshold_days: data.nearExpiryThresholdDays,
      });
      toast.success(createdLabel ?? 'Item created', {
        description: `${created.id} · ${created.desc}`,
      });
      onCreated?.();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'item_number_conflict') {
          setSubmitError(
            `${data.itemId} is already in use. Re-open the dialog or pick a different number.`,
          );
          return;
        }
        if (err.code === 'request_invalid' || err.code === 'item_number_invalid') {
          setSubmitError(err.message);
          return;
        }
        setSubmitError(err.message);
        return;
      }
      setSubmitError('Failed to create item. Please try again.');
    }
  };

  // Local "is something in flight" — the dialog's button + cancel
  // disabled state.
  const busy = isSubmitting || createPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>{title ?? 'New inventory item'}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div
              className={
                lockedTier
                  ? 'space-y-5'
                  : 'grid gap-4 sm:grid-cols-[200px_1fr]'
              }
            >
              <Field
                id="ni-itemId"
                label={lockedTier ? 'SKU' : 'Item #'}
                error={errors.itemId?.message}
              >
                {lockedTier ? (
                  <>
                    <div className="flex">
                      <span className="inline-flex select-none items-center rounded-l-md border border-r-0 border-border bg-surface px-3 font-mono text-sm text-text-2">
                        {skuPrefix}-
                      </span>
                      <Input
                        id="ni-itemId"
                        placeholder="001"
                        className="rounded-l-none font-mono"
                        aria-invalid={Boolean(errors.itemId)}
                        {...register('itemId')}
                      />
                    </div>
                    <p className="text-xs text-text-3">
                      Full SKU: <span className="font-mono text-text-2">{fullSku}</span>
                    </p>
                  </>
                ) : (
                  <Input
                    id="ni-itemId"
                    placeholder={
                      selectedTier
                        ? `e.g. ${selectedTier.prefix}-0001`
                        : 'e.g. UR-0001'
                    }
                    className="font-mono"
                    aria-invalid={Boolean(errors.itemId)}
                    {...register('itemId')}
                  />
                )}
              </Field>
              <Field
                id="ni-desc"
                label={lockedTier ? 'Name' : 'Description'}
                error={errors.desc?.message}
              >
                <Input
                  id="ni-desc"
                  placeholder="e.g. Medical Tube, PVC 6mm"
                  aria-invalid={Boolean(errors.desc)}
                  {...register('desc')}
                />
              </Field>
            </div>

            {!lockedTier && (
              <Field id="ni-tier" label="Tier" error={errors.tierId?.message}>
                <Select
                  value={tierId}
                  onValueChange={(v) =>
                    setValue('tierId', v, { shouldValidate: true })
                  }
                >
                  <SelectTrigger id="ni-tier" aria-label="Tier">
                    <SelectValue placeholder="Pick a tier" />
                  </SelectTrigger>
                  <SelectContent>
                    {tiers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="flex items-center gap-2">
                          <span className="truncate">{c.name}</span>
                          <Badge tone={isBuiltTier(c.type) ? 'accent' : 'neutral'}>
                            {TIER_TYPE_LABELS[c.type]}
                          </Badge>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-text-3">
                  The tier decides whether this is a Product (can have a BOM) or
                  a Purchased item. Manage the BOM from the item&apos;s detail page.
                </p>
              </Field>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ni-uom" label="Unit" error={errors.uom?.message}>
                <Input
                  id="ni-uom"
                  placeholder="each, mL, box…"
                  aria-invalid={Boolean(errors.uom)}
                  {...register('uom')}
                />
              </Field>
              {showPurchasing && (
                <div className="flex items-center justify-between gap-4 self-end rounded-md border border-border bg-surface px-3 py-2">
                  <div className="space-y-0.5">
                    <Label htmlFor="ni-consumable">Consumable</Label>
                    <p className="text-xs text-text-3">Blind-consumed, no lot traceability</p>
                  </div>
                  <Switch
                    id="ni-consumable"
                    checked={isConsumable}
                    onCheckedChange={(v) => setValue('isConsumable', v)}
                  />
                </div>
              )}
            </div>

            {showPurchasing && (
              <>
                <Field
                  id="ni-suppliers"
                  label="Suppliers"
                  error={errors.supplierIds?.message}
                >
                  <SupplierMultiSelect
                    id="ni-suppliers"
                    modal
                    suppliers={suppliers}
                    value={supplierIds}
                    onChange={(next) =>
                      setValue('supplierIds', next, { shouldValidate: true })
                    }
                    loading={suppliersLoading}
                    error={suppliersError}
                  />
                  <p className="text-xs text-text-3">
                    Only these suppliers can be selected when receiving stock for this
                    item.
                  </p>
                </Field>

                <Field
                  id="ni-lead"
                  label="Lead time (days)"
                  error={errors.leadDays?.message}
                >
                  <Input
                    id="ni-lead"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    {...register('leadDays')}
                  />
                </Field>
              </>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ni-thr" label="Reorder threshold" error={errors.threshold?.message}>
                <Input
                  id="ni-thr"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  placeholder="e.g. 5"
                  {...register('threshold')}
                />
              </Field>
              <Field
                id="ni-near-expiry"
                label="Near expiry threshold (days)"
                error={errors.nearExpiryThresholdDays?.message}
              >
                <Input
                  id="ni-near-expiry"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={3650}
                  step={1}
                  placeholder="e.g. 30"
                  {...register('nearExpiryThresholdDays')}
                />
              </Field>
            </div>

            <p className="rounded-md border border-border bg-surface px-3 py-2.5 text-xs text-text-2">
              {showPurchasing
                ? 'After creating, you’ll be able to record the first unit in to bring the item into stock. The item is initially created with zero balance.'
                : 'After creating, open the item’s detail page to define its bill of materials. The item is initially created with zero balance.'}
            </p>

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
              variant="default"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Creating…' : (submitLabel ?? 'Create item')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
