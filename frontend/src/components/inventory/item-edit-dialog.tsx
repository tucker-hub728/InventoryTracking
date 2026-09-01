'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

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
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { itemsApi, type ApiItem, type ItemUpdateInput } from '@/lib/api/items';
import { suppliersApi, type Supplier } from '@/lib/api/suppliers';
import { TIER_TYPE_LABELS } from '@/lib/api/tiers';

import { SupplierMultiSelect } from './supplier-multi-select';

const schema = z.object({
  description: z.string().min(1, 'Name is required').max(512),
  // ``tier_id`` is deliberately absent — the tier is fixed at creation and
  // named by the dialog title, so it is never a field and never part of the
  // patch.
  uom: z.string().trim().max(32, 'Unit is too long').optional(),
  // No ORDER unit here (REQ-001) — the pack belongs to the PO line, and is
  // edited there or corrected at receive.
  supplier_ids: z.array(z.string()).default([]),
  avg_lead_days: z
    .string()
    .optional()
    .refine(
      (v) => !v || (/^\d+$/.test(v) && Number(v) >= 0 && Number(v) <= 3650),
      'Lead time must be a positive integer (days)',
    ),
  reorder_threshold: z
    .string()
    .optional()
    .refine(
      (v) => !v || (/^\d+$/.test(v) && Number(v) >= 0),
      'Threshold must be a non-negative whole number',
    ),
  near_expiry_threshold_days: z
    .string()
    .optional()
    .refine(
      (v) => !v || (/^\d+$/.test(v) && Number(v) >= 0 && Number(v) <= 3650),
      'Near-expiry threshold must be a whole number of days (0–3650)',
    ),
  must_order_flag: z.boolean(),
  // REQ-2026-07-31-KIT-003. Editable after creation (client 2026-09-01): the
  // twin item exists precisely so media can enter a BOM, and whether a given
  // item plays that role is a decision people revise. Create-only would have
  // meant deleting and re-creating an item — and its part number — to change it.
  consumed_in_kit: z.boolean(),
  });

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Backend UUID of the item being edited. The dialog fetches the
   * fresh ApiItem on open so the defaults reflect server state (not
   * a possibly-stale parent prop).
   */
  itemId: string | null;
  onUpdated?: () => void;
}

/** Sorted-equal check for two supplier-id lists (order-insensitive). */
function sameSupplierSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Edit dialog for the inventory item detail page. Captures the
 * commonly-edited fields: name, unit, thresholds, and — for raw materials
 * only — assigned suppliers, lead time and the must-order flag.
 *
 * Neither ``item_number`` nor the tier is editable, and neither is shown as a
 * field — the number sits in the dialog subtitle and the tier is named by the
 * dialog title ("Edit Finished Good"). The SKU is prefixed from the tier, so
 * letting the tier move while the number stays put would strand FG-001 in the
 * Sub-Assemblies tier. Pricing lives on the lot, not the item.
 *
 * Submit sends only what changed so the audit diff shows the operator's
 * actual intent. The supplier list is sent whole (replace semantics) when it
 * differs from what loaded.
 */
export function ItemEditDialog({ open, onOpenChange, itemId, onUpdated }: Props) {
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [suppliersError, setSuppliersError] = React.useState<string | null>(null);
  const [item, setItem] = React.useState<ApiItem | null>(null);
  // The supplier list as it was when the dialog loaded — submit diffs against it.
  const [loadedSupplierIds, setLoadedSupplierIds] = React.useState<string[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      description: '',
      uom: '',
      supplier_ids: [],
      avg_lead_days: '',
      reorder_threshold: '',
      near_expiry_threshold_days: '',
      must_order_flag: false,
      consumed_in_kit: false,
    },
  });

  const supplierIds = watch('supplier_ids');
  const mustOrder = watch('must_order_flag');
  const consumedInKit = watch('consumed_in_kit');

  // Supplier-side fields apply only to the raw-material tier (a built AY/FG is
  // manufactured, not bought) — suppliers, lead time, must-order. Near-expiry
  // rides the same gate for now (deferred on AY/FG). Reorder threshold sits
  // outside it: planning needs it on every tier. See ``new-item-dialog.tsx``
  // for the citations. Read off the item itself, since the tier is fixed.
  const showPurchasing = item?.tier_type === 'raw_material';

  // Load suppliers + the fresh item state every time the dialog opens.
  // ``activeOnly: false`` so a supplier that's since been deactivated still
  // appears in the list (and can be unchecked).
  React.useEffect(() => {
    if (!open || !itemId) {
      setItem(null);
      setLoadError(null);
      return;
    }
    const ctrl = new AbortController();
    setSuppliersError(null);
    Promise.all([
      // ``listAll``, not ``list``: this is a searchable multi-select over the
      // whole supplier master, and a paged response would quietly drop the
      // suppliers an item is already assigned to off the end of page one.
      suppliersApi.listAll({ activeOnly: false, signal: ctrl.signal }),
      itemsApi.get(itemId, { signal: ctrl.signal }),
    ])
      .then(([supplierList, freshItem]) => {
        setSuppliers(supplierList);
        setItem(freshItem);
        const ids = freshItem.suppliers.map((v) => v.supplier_id);
        setLoadedSupplierIds(ids);
        reset({
          description: freshItem.description,
          uom: freshItem.uom ?? '',
          supplier_ids: ids,
          avg_lead_days: freshItem.avg_lead_days != null ? String(freshItem.avg_lead_days) : '',
          // Reorder threshold is a whole count of units — never decimal. The
          // API returns it as a NUMERIC string (e.g. "5.000"); show the whole
          // number only.
          reorder_threshold:
            freshItem.reorder_threshold != null
              ? String(Math.round(Number(freshItem.reorder_threshold)))
              : '',
          near_expiry_threshold_days:
            freshItem.near_expiry_threshold_days != null
              ? String(freshItem.near_expiry_threshold_days)
              : '',
          must_order_flag: freshItem.must_order_flag,
          consumed_in_kit: freshItem.consumed_in_kit,
        });
        setSubmitError(null);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load item.');
      });
    return () => ctrl.abort();
  }, [open, itemId, reset]);

  const onSubmit = async (values: FormValues): Promise<void> => {
    if (!item) return;
    setSubmitError(null);

    const patch: ItemUpdateInput = {};
    if (dirtyFields.description) patch.description = values.description.trim();
    if (dirtyFields.uom) patch.uom = values.uom?.trim() ? values.uom.trim() : null;
    if (!sameSupplierSet(values.supplier_ids, loadedSupplierIds)) {
      patch.supplier_ids = values.supplier_ids;
    }
    if (dirtyFields.avg_lead_days) {
      patch.avg_lead_days = values.avg_lead_days ? Number(values.avg_lead_days) : null;
    }
    if (dirtyFields.reorder_threshold) {
      patch.reorder_threshold = values.reorder_threshold ? Number(values.reorder_threshold) : 0;
    }
    if (dirtyFields.near_expiry_threshold_days) {
      // Non-nullable column (default 30): a cleared field falls back to 0,
      // mirroring how reorder_threshold treats an empty value here.
      patch.near_expiry_threshold_days = values.near_expiry_threshold_days
        ? Number(values.near_expiry_threshold_days)
        : 0;
    }
    if (dirtyFields.must_order_flag) patch.must_order_flag = values.must_order_flag;
    if (dirtyFields.consumed_in_kit) patch.consumed_in_kit = values.consumed_in_kit;

    if (Object.keys(patch).length === 0) {
      setSubmitError('No changes to save.');
      return;
    }

    try {
      await itemsApi.update(item.id, patch);
      toast.success('Item updated', { description: item.item_number });
      onUpdated?.();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bom_present') {
        setSubmitError(
          'This Product has a bill of materials — remove its BOM before moving it to a Purchased tier.',
        );
        return;
      }
      if (err instanceof ApiError && err.code === 'item_received') {
        setSubmitError(
          'This item has received stock (lots), so it can’t be changed to a Product tier. Products are built, not received.',
        );
        return;
      }
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to update item.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>
              {item ? `Edit ${TIER_TYPE_LABELS[item.tier_type]}` : 'Edit item'}
            </DialogTitle>
            <DialogDescription>
              {item ? (
                <>
                  <span className="font-mono text-accent">{item.item_number}</span> · Every change
                  is recorded to the audit log with a before/after diff. The item number and tier
                  are immutable.
                </>
              ) : (
                'Loading item…'
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {loadError && (
              <p
                role="alert"
                className="border-danger/30 bg-danger/5 rounded-md border px-3 py-2 text-xs text-danger"
              >
                {loadError}
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="it-desc">
                Name <span className="text-danger">*</span>
              </Label>
              <Input
                id="it-desc"
                aria-invalid={Boolean(errors.description)}
                {...register('description')}
              />
              {errors.description && (
                <p role="alert" className="text-xs text-danger">
                  {errors.description.message}
                </p>
              )}
            </div>

            {/* Unit + Reorder threshold are the two fields every tier shows, so
                they pair up here. The purchasing-only fields (suppliers, lead
                time, near-expiry, must-order) live in the block below. */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="it-uom">Consume unit</Label>
                <Input
                  id="it-uom"
                  placeholder="each, mL, vial…"
                  aria-invalid={Boolean(errors.uom)}
                  {...register('uom')}
                />
                {errors.uom && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.uom.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="it-threshold">Reorder threshold</Label>
                <Input
                  id="it-threshold"
                  type="number"
                  inputMode="numeric"
                  step="1"
                  min={0}
                  aria-invalid={Boolean(errors.reorder_threshold)}
                  {...register('reorder_threshold')}
                />
                {errors.reorder_threshold && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.reorder_threshold.message}
                  </p>
                )}
              </div>
            </div>

            {showPurchasing && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="it-suppliers">Suppliers</Label>
                  <SupplierMultiSelect
                    id="it-suppliers"
                    modal
                    suppliers={suppliers}
                    value={supplierIds}
                    onChange={(next) => setValue('supplier_ids', next, { shouldDirty: true })}
                    error={suppliersError}
                  />
                  <p className="text-xs text-text-3">
                    Only these suppliers can be selected when receiving stock for this item.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="it-lead">Lead time (days)</Label>
                    <Input
                      id="it-lead"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={3650}
                      aria-invalid={Boolean(errors.avg_lead_days)}
                      {...register('avg_lead_days')}
                    />
                    {errors.avg_lead_days && (
                      <p role="alert" className="text-xs text-danger">
                        {errors.avg_lead_days.message}
                      </p>
                    )}
                  </div>
                  {/* Near-expiry: purchased tiers only for now — see the matching
                      note in ``new-item-dialog``. Deferred, not dropped. */}
                  <div className="space-y-1.5">
                    <Label htmlFor="it-near-expiry">Near expiry (days)</Label>
                    <Input
                      id="it-near-expiry"
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min={0}
                      max={3650}
                      aria-invalid={Boolean(errors.near_expiry_threshold_days)}
                      {...register('near_expiry_threshold_days')}
                    />
                    {errors.near_expiry_threshold_days && (
                      <p role="alert" className="text-xs text-danger">
                        {errors.near_expiry_threshold_days.message}
                      </p>
                    )}
                  </div>
                </div>

                {/* Offered only on a NON-consumable: the two flags are mutually
                    exclusive (ck_items_consumable_xor_consumed_in_kit), and a
                    consumable is barred from bills of material anyway, so on one
                    the switch would be a control that can only produce a 422.
                    `is_consumable` itself stays create-only — changing it would
                    silently change whether existing BOM lines are legal. */}
                {!item?.is_consumable && (
                  <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface px-3 py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="it-consumed-in-kit">Consumed to the kit</Label>
                      <p className="text-xs text-text-3">
                        Media and the like: consumed when replaced, never back-flushed
                      </p>
                    </div>
                    <Switch
                      id="it-consumed-in-kit"
                      checked={consumedInKit}
                      onCheckedChange={(v) =>
                        setValue('consumed_in_kit', v, { shouldDirty: true })
                      }
                    />
                  </div>
                )}

                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={mustOrder}
                    onChange={(e) =>
                      setValue('must_order_flag', e.target.checked, {
                        shouldDirty: true,
                      })
                    }
                    className="size-4"
                  />
                  <span>Flag as must-order for next PO</span>
                </label>
              </>
            )}

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
            <Button type="button" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
