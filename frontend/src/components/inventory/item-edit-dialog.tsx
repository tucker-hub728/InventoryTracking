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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { itemsApi, type ApiItem, type ItemUpdateInput } from '@/lib/api/items';
import { vendorsApi, type Vendor } from '@/lib/api/vendors';

const NULL_VENDOR = '__none__';

const schema = z.object({
  description: z.string().min(1, 'Description is required').max(512),
  vendor_id: z.string(),
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
      (v) => !v || (/^\d+(\.\d+)?$/.test(v) && Number(v) >= 0),
      'Threshold must be a non-negative number',
    ),
  unit_price_amount: z
    .string()
    .optional()
    .refine(
      (v) => !v || (/^\d+(\.\d+)?$/.test(v) && Number(v) >= 0),
      'Unit price must be a non-negative number',
    ),
  units_per_package: z
    .string()
    .optional()
    .refine(
      (v) => !v || (/^\d+$/.test(v) && Number(v) >= 1),
      'Units per package must be a positive integer',
    ),
  po_note: z.string().max(1024).optional(),
  notes: z.string().max(2048).optional(),
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

/**
 * Edit dialog for the inventory item detail page. Captures the
 * commonly-edited fields: description, vendor, threshold, pricing,
 * notes. ``item_number`` and ``uom_code`` are NOT here — the former
 * is immutable, the latter only editable while the item has zero
 * stock (a path the operator can request via an admin escalation).
 *
 * Submit uses dirtyFields to send only what changed so the audit
 * diff shows the operator's actual intent.
 */
export function ItemEditDialog({ open, onOpenChange, itemId, onUpdated }: Props) {
  const [vendors, setVendors] = React.useState<Vendor[]>([]);
  const [item, setItem] = React.useState<ApiItem | null>(null);
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
      vendor_id: NULL_VENDOR,
      avg_lead_days: '',
      reorder_threshold: '',
      unit_price_amount: '',
      units_per_package: '',
      po_note: '',
      notes: '',
      must_order_flag: false,
    },
  });

  const vendorId = watch('vendor_id');
  const mustOrder = watch('must_order_flag');

  // Load vendors + the fresh item state every time the dialog opens.
  // ``activeOnly: false`` so a vendor that's since been deactivated
  // still resolves on the dropdown (and gets a label).
  React.useEffect(() => {
    if (!open || !itemId) {
      setItem(null);
      setLoadError(null);
      return;
    }
    const ctrl = new AbortController();
    Promise.all([
      vendorsApi.list({ activeOnly: false, signal: ctrl.signal }),
      itemsApi.get(itemId, { signal: ctrl.signal }),
    ])
      .then(([vendorList, freshItem]) => {
        setVendors(vendorList);
        setItem(freshItem);
        reset({
          description: freshItem.description,
          vendor_id: freshItem.vendor_id ?? NULL_VENDOR,
          avg_lead_days:
            freshItem.avg_lead_days != null ? String(freshItem.avg_lead_days) : '',
          reorder_threshold:
            freshItem.reorder_threshold != null
              ? String(freshItem.reorder_threshold)
              : '',
          unit_price_amount:
            freshItem.unit_price_amount != null
              ? String(freshItem.unit_price_amount)
              : '',
          units_per_package:
            freshItem.units_per_package != null
              ? String(freshItem.units_per_package)
              : '',
          po_note: freshItem.po_note ?? '',
          notes: freshItem.notes ?? '',
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
    if (dirtyFields.vendor_id) {
      patch.vendor_id =
        values.vendor_id === NULL_VENDOR ? null : values.vendor_id;
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
    if (dirtyFields.unit_price_amount) {
      patch.unit_price_amount = values.unit_price_amount
        ? Number(values.unit_price_amount)
        : null;
    }
    if (dirtyFields.units_per_package) {
      patch.units_per_package = values.units_per_package
        ? Number(values.units_per_package)
        : null;
    }
    if (dirtyFields.po_note) patch.po_note = values.po_note?.trim() || null;
    if (dirtyFields.notes) patch.notes = values.notes?.trim() || null;
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
                  Every change is recorded to the audit log with a
                  before/after diff. ``item_number`` is immutable.
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

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="it-vendor">Vendor</Label>
                <Select
                  value={vendorId}
                  onValueChange={(v) =>
                    setValue('vendor_id', v, {
                      shouldValidate: true,
                      shouldDirty: true,
                    })
                  }
                >
                  <SelectTrigger id="it-vendor">
                    <SelectValue placeholder="No vendor" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={NULL_VENDOR}>— None —</SelectItem>
                    {vendors.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name}
                        {!v.is_active && (
                          <span className="ml-2 text-xs text-text-3">(inactive)</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="it-threshold">Reorder threshold</Label>
                <Input
                  id="it-threshold"
                  type="number"
                  inputMode="decimal"
                  step="0.001"
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
                <Label htmlFor="it-price">Unit price</Label>
                <Input
                  id="it-price"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  aria-invalid={Boolean(errors.unit_price_amount)}
                  {...register('unit_price_amount')}
                />
                {errors.unit_price_amount && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.unit_price_amount.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="it-uperpkg">Units / package</Label>
                <Input
                  id="it-uperpkg"
                  type="number"
                  inputMode="numeric"
                  step="1"
                  min={1}
                  aria-invalid={Boolean(errors.units_per_package)}
                  {...register('units_per_package')}
                />
                {errors.units_per_package && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.units_per_package.message}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="it-po-note">PO note</Label>
              <Input
                id="it-po-note"
                placeholder="e.g. Quote ref #1234"
                {...register('po_note')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="it-notes">Notes</Label>
              <Textarea id="it-notes" rows={3} {...register('notes')} />
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
