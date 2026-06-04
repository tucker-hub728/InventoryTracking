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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import {
  lotsApi,
  LOT_STATUS_OPTIONS,
  type Lot,
  type LotCreateInput,
  type LotStatus,
} from '@/lib/api/lots';
import { itemsApi, type ApiItem } from '@/lib/api/items';
import { vendorsApi, type Vendor } from '@/lib/api/vendors';

const STATUS_CODES = LOT_STATUS_OPTIONS.map((o) => o.code) as [LotStatus, ...LotStatus[]];
const NO_VENDOR = '__none__';

const schema = z
  .object({
    item_id: z.string().uuid('Pick an item'),
    lot_number: z.string().trim().min(1, 'Lot number is required').max(64),
    vendor_id: z.string().optional(),
    manufacture_date: z.string().optional(),
    expiration_date: z.string().min(1, 'Expiration date is required'),
    coa_url: z.string().url('Must be a valid URL').optional().or(z.literal('')),
    status: z.enum(STATUS_CODES),
    notes: z.string().max(2048).optional(),
  })
  .refine(
    (v) =>
      !v.manufacture_date ||
      !v.expiration_date ||
      v.expiration_date >= v.manufacture_date,
    { message: 'Expiration must be on or after manufacture date', path: ['expiration_date'] },
  );

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (lot: Lot) => void;
}

export function LotCreateDialog({ open, onOpenChange, onCreated }: Props) {
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<ApiItem[]>([]);
  const [vendors, setVendors] = React.useState<Vendor[]>([]);
  const [pickersLoading, setPickersLoading] = React.useState(false);
  const [pickersError, setPickersError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      item_id: '',
      lot_number: '',
      vendor_id: '',
      manufacture_date: '',
      expiration_date: '',
      coa_url: '',
      status: 'released',
      notes: '',
    },
  });

  const itemId = watch('item_id');
  const vendorId = watch('vendor_id');
  const status = watch('status');

  // Load items + vendors when the dialog opens. Both lists are bounded
  // (≤ a few hundred rows in v1), so one-shot fetch is fine.
  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setPickersLoading(true);
    setPickersError(null);
    Promise.all([
      itemsApi.list({ limit: 200, sort: 'item_number', direction: 'asc' }, { signal: ctrl.signal }),
      vendorsApi.list({ activeOnly: true, signal: ctrl.signal }),
    ])
      .then(([itemList, vendorList]) => {
        setItems(itemList.items);
        setVendors(vendorList);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setPickersError(
          err instanceof ApiError ? err.message : 'Failed to load item / vendor pickers.',
        );
      })
      .finally(() => setPickersLoading(false));
    return () => ctrl.abort();
  }, [open]);

  React.useEffect(() => {
    if (!open) {
      reset();
      setSubmitError(null);
    }
  }, [open, reset]);

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    const payload: LotCreateInput = {
      lot_number: values.lot_number.trim(),
      vendor_id:
        values.vendor_id && values.vendor_id !== NO_VENDOR ? values.vendor_id : null,
      manufacture_date: values.manufacture_date || null,
      expiration_date: values.expiration_date || null,
      coa_url: values.coa_url?.trim() || null,
      status: values.status,
      notes: values.notes?.trim() || null,
    };
    try {
      const created = await lotsApi.create(values.item_id, payload);
      onCreated(created);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'lot_number_conflict') {
          setSubmitError(
            `Lot "${payload.lot_number}" is already in use for the selected item.`,
          );
          return;
        }
        if (err.code === 'lot_dates_inverted') {
          setSubmitError(err.message);
          return;
        }
        setSubmitError(err.message);
        return;
      }
      setSubmitError('Failed to create lot.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Add lot</DialogTitle>
            <DialogDescription>
              Manufacturer batch of an item — used for traceability, expiry, and recalls.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="lot-item">
                Item <span className="text-danger">*</span>
              </Label>
              <Select
                value={itemId || ''}
                onValueChange={(v) => setValue('item_id', v, { shouldValidate: true })}
                disabled={pickersLoading || items.length === 0}
              >
                <SelectTrigger id="lot-item" aria-invalid={Boolean(errors.item_id)}>
                  <SelectValue
                    placeholder={
                      pickersLoading
                        ? 'Loading items…'
                        : pickersError
                          ? 'Could not load items'
                          : items.length === 0
                            ? 'No items available'
                            : 'Select item'
                    }
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

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lot-number">
                  Lot # <span className="text-danger">*</span>
                </Label>
                <Input
                  id="lot-number"
                  placeholder="L-20260528-A"
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
                <Label htmlFor="lot-status">Status</Label>
                <Select
                  value={status}
                  onValueChange={(v) =>
                    setValue('status', v as LotStatus, { shouldValidate: true })
                  }
                >
                  <SelectTrigger id="lot-status">
                    <SelectValue placeholder="Status" />
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
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="lot-vendor">Vendor</Label>
              <Select
                value={vendorId || ''}
                onValueChange={(v) => setValue('vendor_id', v, { shouldValidate: true })}
                disabled={pickersLoading || vendors.length === 0}
              >
                <SelectTrigger id="lot-vendor">
                  <SelectValue
                    placeholder={pickersLoading ? 'Loading vendors…' : 'Select vendor (optional)'}
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

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lot-mfg">Manufacture date</Label>
                <Input id="lot-mfg" type="date" {...register('manufacture_date')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lot-exp">
                  Expiration date <span className="text-danger">*</span>
                </Label>
                <Input
                  id="lot-exp"
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
              <Label htmlFor="lot-coa">Certificate of Analysis URL</Label>
              <Input
                id="lot-coa"
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
              <Label htmlFor="lot-notes">Notes</Label>
              <Input id="lot-notes" {...register('notes')} />
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
            <Button type="button" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Add lot'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
