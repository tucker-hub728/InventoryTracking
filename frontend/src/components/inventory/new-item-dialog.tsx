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
  defaultPrefix,
  TIER_TYPE_LABELS,
  type ApiTier,
} from '@/lib/api/tiers';
import { usePermission } from '@/hooks/use-permission';
import { PrefixFormDialog } from '@/components/tiers/prefix-form-dialog';

import { SupplierMultiSelect } from './supplier-multi-select';

/** Sentinel value for the dropdown's "New prefix…" entry. Prefixes stay
 *  admin-governed (REQ-2026-07-09-ITM-003) — this just opens the e-signed
 *  prefix dialog inline instead of sending the operator to the admin screen. */
const NEW_PREFIX_VALUE = '__new_prefix__';

// ── Form schema ────────────────────────────────────────────────────────

const schema = z.object({
  // The SKU tail only (e.g. '001'). The full number is derived as
  // ``<prefix code>-<suffix>`` server-side, so the operator types the tail and
  // picks the prefix separately. Uniqueness is per (prefix, suffix).
  suffix: z
    .string()
    .trim()
    .min(1, 'Number is required')
    .max(64, 'Number must be at most 64 characters'),
  desc: z.string().min(3, 'Description is required'),
  // Required tier — governs whether the item is a Product (built) or
  // Purchased, and thus BOM eligibility. Only used to scope the prefix picker;
  // the backend derives the tier from the chosen prefix.
  tierId: z.string().min(1, 'Tier is required'),
  // Required prefix — assigned to the item (REQ-2026-07-09-ITM-001). Lives
  // inside the selected tier; pre-filled with that tier's default.
  prefixId: z.string().min(1, 'Prefix is required'),
  // The CONSUME unit (each, mL …) — what stock is counted in. Optional.
  uom: z.string().trim().max(32, 'Unit is too long').optional().default(''),
  // No ORDER unit here (REQ-001) — the pack an item is bought in is captured
  // on the PO line and confirmed at receive, because it belongs to the
  // purchase and not to the material.
  // Blind-consumed, no per-lot traceability.
  isConsumable: z.boolean().default(false),
  // REQ-003: receiving demands a lot number when true. Defaults true —
  // requiring one is the status quo and the conservative choice.
  isLotControlled: z.boolean().default(true),
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
  // Creating a prefix is an e-signed admin action — only offer it to signers.
  const canManagePrefixes = usePermission('inventory', 'sign');
  const [addingPrefix, setAddingPrefix] = React.useState(false);

  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    clearErrors,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      suffix: '',
      desc: '',
      tierId: lockedTier?.id ?? '',
      prefixId: lockedTier ? (defaultPrefix(lockedTier)?.id ?? '') : '',
      uom: '',
      isConsumable: false,
      isLotControlled: true,
      supplierIds: [],
      leadDays: 0,
      threshold: 0,
      nearExpiryThresholdDays: 30,
    },
  });

  const supplierIds = watch('supplierIds');
  const tierId = watch('tierId');
  const prefixId = watch('prefixId');
  const isConsumable = watch('isConsumable');
  const isLotControlled = watch('isLotControlled');
  const suffix = watch('suffix');
  // The tier whose prefixes scope the picker, and the chosen prefix within it.
  // A locked tier is re-resolved from the fetched list so a prefix added from
  // this dialog shows up immediately (the prop itself is a stale snapshot).
  const resolvedLocked = lockedTier
    ? (tiers.find((t) => t.id === lockedTier.id) ?? lockedTier)
    : null;
  const selectedTier = resolvedLocked ?? tiers.find((c) => c.id === tierId);
  const tierPrefixes = selectedTier?.prefixes ?? [];
  const selectedPrefix = tierPrefixes.find((p) => p.id === prefixId) ?? null;
  // Offer the picker when there's a real choice, or when the operator may add
  // one inline. Otherwise the single prefix renders as a static addon.
  const canPickPrefix = Boolean(selectedTier) && (tierPrefixes.length > 1 || canManagePrefixes);

  // The SKU is fronted with the chosen prefix code; the operator types the tail.
  const skuPrefix = selectedPrefix?.code ?? '';
  const fullSku = skuPrefix ? `${skuPrefix}-${suffix.trim()}` : suffix.trim();

  // Supplier-side fields only apply to Purchased tiers — a built item
  // (AY/FG) is manufactured, not bought, so it has no supplier and no supplier
  // lead time (REQ-2026-07-01-INV-002; per-supplier lead time is future state
  // per REQ-2026-07-09-PLN-006). The consumable flag is likewise CR-only —
  // Transaction Spec §1.1: "A CR item may be designated as either a raw
  // material or a consumable."
  //
  // Reorder threshold is NOT a supplier field and stays on every tier —
  // planning nets sub-assemblies against on-hand (REQ-2026-07-09-PLN-002).
  //
  // Near-expiry also rides this gate for now, hidden on the built tiers by
  // request: INV-008 and Transaction Spec §3.1 do want a tracked expiry on
  // finished goods, but nothing reads the window on AY/FG until manual
  // transact-in ships, so it is deferred rather than dropped.
  const showPurchasing = selectedTier?.type === 'raw_material';

  // ── Side effects ─────────────────────────────────────────────────────

  // Load suppliers once when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setSuppliersLoading(true);
    setSuppliersError(null);
    suppliersApi
      // ``listAll``: this is a searchable picker over the whole active supplier
      // master, so a paged response would hide everything past the first page.
      .listAll({ activeOnly: true, signal: ctrl.signal })
      .then((rows) => setSuppliers(rows))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setSuppliersError(err instanceof ApiError ? err.message : 'Failed to load suppliers.');
      })
      .finally(() => setSuppliersLoading(false));
    return () => ctrl.abort();
  }, [open]);

  // Refetch the tiers (and their prefixes). Also called after adding a prefix
  // inline so the new one appears in the picker straight away.
  const reloadTiers = React.useCallback(async (signal?: AbortSignal) => {
    try {
      setTiers(await tiersApi.list({ signal }));
    } catch {
      /* surfaced via the empty dropdown */
    }
  }, []);

  // Load tiers when the dialog opens. Fetched even for a locked tier so the
  // prefix list stays fresh after an inline "New prefix".
  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    void reloadTiers(ctrl.signal);
    return () => ctrl.abort();
  }, [open, reloadTiers]);

  // Seed the locked tier + its default prefix when the dialog opens. Keyed on
  // the ids (not the prop object) so a re-render can't clobber a prefix the
  // operator just picked or created inline.
  const lockedTierId = lockedTier?.id ?? null;
  const lockedDefaultPrefixId = lockedTier ? (defaultPrefix(lockedTier)?.id ?? '') : '';
  React.useEffect(() => {
    if (!open || !lockedTierId) return;
    setValue('tierId', lockedTierId, { shouldValidate: true });
    setValue('prefixId', lockedDefaultPrefixId, { shouldValidate: true });
  }, [open, lockedTierId, lockedDefaultPrefixId, setValue]);

  // When the operator picks a different tier, jump the prefix to that tier's
  // default (a prefix can't cross tiers). Skipped when the tier is locked.
  React.useEffect(() => {
    if (!open || lockedTier || !tierId) return;
    const tier = tiers.find((c) => c.id === tierId);
    if (!tier) return;
    // Only reset when the current prefix isn't one of the new tier's prefixes.
    const stillValid = tier.prefixes.some((p) => p.id === prefixId);
    if (!stillValid) {
      setValue('prefixId', defaultPrefix(tier)?.id ?? '', { shouldValidate: true });
    }
  }, [open, lockedTier, tierId, tiers, prefixId, setValue]);

  // Reset the form when the dialog closes.
  React.useEffect(() => {
    if (!open) {
      reset({
        suffix: '',
        desc: '',
        tierId: lockedTier?.id ?? '',
        prefixId: lockedTier ? (defaultPrefix(lockedTier)?.id ?? '') : '',
        uom: '',
        isConsumable: false,
        isLotControlled: true,
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
    // A raw material is purchased, so it must have at least one supplier
    // (built items are manufactured and have none — the field is hidden there).
    if (showPurchasing && data.supplierIds.length === 0) {
      setError('supplierIds', {
        type: 'manual',
        message: 'Select at least one supplier.',
      });
      return;
    }
    try {
      const created = await createItem({
        sku_suffix: data.suffix,
        description: data.desc,
        prefix_id: data.prefixId,
        uom: data.uom ? data.uom : null,
        is_consumable: data.isConsumable,
        is_lot_controlled: data.isLotControlled,
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
          setSubmitError(`${fullSku} is already in use. Pick a different number.`);
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

  // A prefix created inline is a real (e-signed) prefix row — refetch so it
  // appears in the picker, then select it.
  const onPrefixCreated = async (saved: { id: string }) => {
    await reloadTiers();
    setValue('prefixId', saved.id, { shouldValidate: true });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <form onSubmit={handleSubmit(onSubmit)}>
            <DialogHeader>
              <DialogTitle>{title ?? 'New inventory item'}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </DialogHeader>
            <DialogBody className="space-y-5">
              {/* Tier (non-locked): scopes the prefix choices and decides
                Product (can have a BOM) vs Purchased. */}
              {!lockedTier && (
                <Field id="ni-tier" label="Tier" error={errors.tierId?.message}>
                  <Select
                    value={tierId}
                    onValueChange={(v) => setValue('tierId', v, { shouldValidate: true })}
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
                </Field>
              )}

              <div
                className={
                  lockedTier ? 'space-y-5' : 'grid gap-4 sm:grid-cols-[minmax(0,260px)_1fr]'
                }
              >
                {/* Item # = inline prefix dropdown + suffix. The full number is
                  derived (prefix code + suffix), so renaming the prefix later
                  re-labels the item. */}
                <Field
                  id="ni-suffix"
                  label="Item #"
                  error={errors.suffix?.message ?? errors.prefixId?.message}
                >
                  <div className="flex">
                    {canPickPrefix ? (
                      <Select
                        value={prefixId}
                        onValueChange={(v) => {
                          // "New prefix…" opens the e-signed admin dialog rather
                          // than selecting a value.
                          if (v === NEW_PREFIX_VALUE) {
                            setAddingPrefix(true);
                            return;
                          }
                          setValue('prefixId', v, { shouldValidate: true });
                        }}
                      >
                        <SelectTrigger
                          aria-label="Prefix"
                          className="w-auto shrink-0 gap-1 rounded-r-none border-r-0 font-mono"
                        >
                          <span className="font-mono">
                            {skuPrefix ? `${skuPrefix}-` : 'Prefix'}
                          </span>
                        </SelectTrigger>
                        <SelectContent>
                          {tierPrefixes.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              <span className="flex items-center gap-2">
                                <span className="font-mono">{p.code}</span>
                                {p.label && <span className="text-text-3">{p.label}</span>}
                                {p.is_default && <Badge tone="neutral">default</Badge>}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="inline-flex select-none items-center rounded-l-md border border-r-0 border-border bg-surface px-3 font-mono text-sm text-text-2">
                        {skuPrefix || '—'}-
                      </span>
                    )}
                    <Input
                      id="ni-suffix"
                      placeholder="001"
                      className="rounded-l-none font-mono"
                      aria-invalid={Boolean(errors.suffix)}
                      {...register('suffix')}
                    />
                  </div>
                  <p className="text-xs text-text-3">
                    Full SKU: <span className="font-mono text-text-2">{fullSku || '—'}</span>
                    {tierPrefixes.length > 1 && ' · prefix follows renames'}
                  </p>
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

              {/* Unit + Reorder threshold are the two fields every tier shows, so
                they pair up here. The purchasing-only fields (consumable flag,
                suppliers, lead time, near-expiry) live in the block below. */}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id="ni-uom"
                  label="Consume unit"
                  error={errors.uom?.message}
                >
                  <Input
                    id="ni-uom"
                    placeholder="each, mL, vial…"
                    aria-invalid={Boolean(errors.uom)}
                    {...register('uom')}
                  />
                </Field>
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
              </div>

              {showPurchasing && (
                <>
                  <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface px-3 py-2">
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

                  {/* A separate switch from Consumable above, deliberately
                      (REQ-003). That one is about how material is used; this is
                      about how it is traced, and a consumable reagent can still
                      need a traceable lot for a deviation investigation. */}
                  <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface px-3 py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="ni-lot-controlled">Lot controlled</Label>
                      <p className="text-xs text-text-3">
                        {isLotControlled
                          ? 'Receiving requires a lot number'
                          : 'Lot number optional — one is generated if left blank'}
                      </p>
                    </div>
                    <Switch
                      id="ni-lot-controlled"
                      checked={isLotControlled}
                      onCheckedChange={(v) => setValue('isLotControlled', v)}
                    />
                  </div>

                  <Field
                    id="ni-suppliers"
                    label={
                      <>
                        Suppliers <span className="text-danger">*</span>
                      </>
                    }
                    error={errors.supplierIds?.message}
                  >
                    <SupplierMultiSelect
                      id="ni-suppliers"
                      modal
                      suppliers={suppliers}
                      value={supplierIds}
                      onChange={(next) => {
                        setValue('supplierIds', next, { shouldValidate: true });
                        if (next.length > 0) clearErrors('supplierIds');
                      }}
                      loading={suppliersLoading}
                      error={suppliersError}
                    />
                    <p className="text-xs text-text-3">
                      Only these suppliers can be selected when receiving stock for this item.
                    </p>
                  </Field>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field id="ni-lead" label="Lead time (days)" error={errors.leadDays?.message}>
                      <Input
                        id="ni-lead"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        {...register('leadDays')}
                      />
                    </Field>
                    {/* Near-expiry: purchased tiers only for now. INV-008 /
                      Transaction Spec §3.1 want a tracked expiry on finished
                      goods, but nothing reads the window on AY/FG until manual
                      transact-in ships, so it is deferred (the column keeps its
                      30-day default). Re-show this field to restore it. */}
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
                </>
              )}

              <p className="rounded-md border border-border bg-surface px-3 py-2.5 text-xs text-text-2">
                {showPurchasing
                  ? 'After creating, you’ll be able to record the first unit in to bring the item into stock. The item is initially created with zero balance.'
                  : 'After creating, open the item’s detail page to define its bill of materials. The item is initially created with zero balance.'}
              </p>

              {submitError && (
                <p
                  role="alert"
                  className="border-danger/30 bg-danger/5 rounded-md border px-3 py-2 text-xs text-danger"
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

      {/* Inline "New prefix…" — a real, e-signed prefix in the selected tier, so
        renames still cascade and per-prefix counts/filtering keep working. */}
      <PrefixFormDialog
        open={addingPrefix}
        onOpenChange={setAddingPrefix}
        tierId={selectedTier?.id ?? ''}
        tierName={selectedTier?.name ?? ''}
        onSaved={(saved) => void onPrefixCreated(saved)}
      />
    </>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: React.ReactNode;
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
