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
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { itemsApi, type ApiItem, type ItemUpdateInput } from '@/lib/api/items';
import { vendorsApi, type Vendor } from '@/lib/api/vendors';

import { VendorMultiSelect } from './vendor-multi-select';

const schema = z.object({
  description: z.string().min(1, 'Description is required').max(512),
  vendor_ids: z.array(z.string()).default([]),
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

/** Sorted-equal check for two vendor-id lists (order-insensitive). */
function sameVendorSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Edit dialog for the inventory item detail page. Captures the
 * commonly-edited fields: description, assigned vendors, lead time,
 * thresholds, must-order flag. ``item_number`` is NOT here — it's the
 * immutable human handle. Pricing lives on the lot, not the item.
 *
 * Submit sends only what changed so the audit diff shows the operator's
 * actual intent. The vendor list is sent whole (replace semantics) when it
 * differs from what loaded.
 */
export function ItemEditDialog({ open, onOpenChange, itemId, onUpdated }: Props) {
  const [vendors, setVendors] = React.useState<Vendor[]>([]);
  const [vendorsError, setVendorsError] = React.useState<string | null>(null);
  const [item, setItem] = React.useState<ApiItem | null>(null);
  // The vendor list as it was when the dialog loaded — submit diffs against it.
  const [loadedVendorIds, setLoadedVendorIds] = React.useState<string[]>([]);
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
      vendor_ids: [],
      avg_lead_days: '',
      reorder_threshold: '',
      near_expiry_threshold_days: '',
      must_order_flag: false,
    },
  });

  const vendorIds = watch('vendor_ids');
  const mustOrder = watch('must_order_flag');

  // Load vendors + the fresh item state every time the dialog opens.
  // ``activeOnly: false`` so a vendor that's since been deactivated still
  // appears in the list (and can be unchecked).
  React.useEffect(() => {
    if (!open || !itemId) {
      setItem(null);
      setLoadError(null);
      return;
    }
    const ctrl = new AbortController();
    setVendorsError(null);
    Promise.all([
      vendorsApi.list({ activeOnly: false, signal: ctrl.signal }),
      itemsApi.get(itemId, { signal: ctrl.signal }),
    ])
      .then(([vendorList, freshItem]) => {
        setVendors(vendorList);
        setItem(freshItem);
        const ids = freshItem.vendors.map((v) => v.vendor_id);
        setLoadedVendorIds(ids);
        reset({
          description: freshItem.description,
          vendor_ids: ids,
          avg_lead_days:
            freshItem.avg_lead_days != null ? String(freshItem.avg_lead_days) : '',
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
        });
        setSubmitError(null);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load item.',
        );
      });
    return () => ctrl.abort();
  }, [open, itemId, reset]);

  const onSubmit = async (values: FormValues): Promise<void> => {
    if (!item) return;
    setSubmitError(null);

    const patch: ItemUpdateInput = {};
    if (dirtyFields.description) patch.description = values.description.trim();
    if (!sameVendorSet(values.vendor_ids, loadedVendorIds)) {
      patch.vendor_ids = values.vendor_ids;
    }
    if (dirtyFields.avg_lead_days) {
      patch.avg_lead_days = values.avg_lead_days
        ? Number(values.avg_lead_days)
        : null;
    }
    if (dirtyFields.reorder_threshold) {
      patch.reorder_threshold = values.reorder_threshold
        ? Number(values.reorder_threshold)
        : 0;
    }
    if (dirtyFields.near_expiry_threshold_days) {
      // Non-nullable column (default 30): a cleared field falls back to 0,
      // mirroring how reorder_threshold treats an empty value here.
      patch.near_expiry_threshold_days = values.near_expiry_threshold_days
        ? Number(values.near_expiry_threshold_days)
        : 0;
    }
    if (dirtyFields.must_order_flag) patch.must_order_flag = values.must_order_flag;

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
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to update item.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Edit item</DialogTitle>
            <DialogDescription>
              {item ? (
                <>
                  <span className="font-mono text-accent">{item.item_number}</span> ·
                  Every change is recorded to the audit log with a before/after
                  diff. The item number is immutable.
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
                className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
              >
                {loadError}
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="it-desc">
                Description <span className="text-danger">*</span>
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

            <div className="space-y-1.5">
              <Label htmlFor="it-vendors">Vendors</Label>
              <VendorMultiSelect
                id="it-vendors"
                vendors={vendors}
                value={vendorIds}
                onChange={(next) =>
                  setValue('vendor_ids', next, { shouldDirty: true })
                }
                error={vendorsError}
              />
              <p className="text-xs text-text-3">
                Only these vendors can be selected when receiving stock for this
                item.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
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
