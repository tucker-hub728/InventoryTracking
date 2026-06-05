'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { useInventoryStore } from '@/stores/inventory.store';
import { ApiError } from '@/lib/api/client';
import { vendorsApi, type Vendor } from '@/lib/api/vendors';

// ── Form schema ────────────────────────────────────────────────────────

const schema = z.object({
  // Free-form, typed directly: a 2–8 char letter-led prefix, dash, digits
  // (e.g. UR-0001). Mirrors the backend CHECK.
  itemId: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{1,7}-\d+$/, 'Item # must look like CM-0001'),
  desc: z.string().min(3, 'Description is required'),
  // Vendor is optional — backend accepts null. UI requires a selection
  // unless the user explicitly chooses "No vendor" so we treat empty as
  // a soft "skipped" rather than an error.
  vendorId: z.string().optional(),
  leadDays: z.coerce.number().int().nonnegative('Must be ≥ 0'),
  unitPrice: z.coerce.number().nonnegative('Must be ≥ 0'),
  unitsPerPackage: z.coerce.number().int().positive('Must be ≥ 1'),
  threshold: z.coerce.number().int().nonnegative('Must be ≥ 0'),
  poNote: z.string().optional(),
  notes: z.string().optional(),
});

type Values = z.infer<typeof schema>;

const NO_VENDOR_VALUE = '__none__';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create (in addition to the toast). Lets a
   *  host list refresh itself — the inventory list relies on the store
   *  refetch instead and omits this. */
  onCreated?: () => void;
}

export function NewItemDialog({ open, onOpenChange, onCreated }: Props) {
  // Store actions — the only thing this component does for I/O.
  const createItem = useInventoryStore((s) => s.create);
  const createPending = useInventoryStore((s) => s.createPending);

  // Vendor dropdown source. Loaded once when the dialog opens — the
  // master-data list is small (≤ ~100 rows) and changes rarely, so a
  // simple on-open fetch beats wiring it into the store.
  const [vendors, setVendors] = React.useState<Vendor[]>([]);
  const [vendorsLoading, setVendorsLoading] = React.useState(false);
  const [vendorsError, setVendorsError] = React.useState<string | null>(null);

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
      vendorId: '',
      leadDays: 0,
      unitPrice: 0,
      unitsPerPackage: 1,
      threshold: 0,
      poNote: '',
      notes: '',
    },
  });

  const vendorId = watch('vendorId');

  // ── Side effects ─────────────────────────────────────────────────────

  // Load vendors once when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setVendorsLoading(true);
    setVendorsError(null);
    vendorsApi
      .list({ activeOnly: true, signal: ctrl.signal })
      .then((rows) => setVendors(rows))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setVendorsError(
          err instanceof ApiError ? err.message : 'Failed to load vendors.',
        );
      })
      .finally(() => setVendorsLoading(false));
    return () => ctrl.abort();
  }, [open]);

  // Reset the form when the dialog closes.
  React.useEffect(() => {
    if (!open) {
      reset({
        itemId: '',
        desc: '',
        vendorId: '',
        leadDays: 0,
        unitPrice: 0,
        unitsPerPackage: 1,
        threshold: 0,
        poNote: '',
        notes: '',
      });
      setSubmitError(null);
    }
  }, [open, reset]);

  // ── Submit ───────────────────────────────────────────────────────────

  const onSubmit = async (data: Values): Promise<void> => {
    setSubmitError(null);
    try {
      const created = await createItem({
        item_number: data.itemId,
        description: data.desc,
        vendor_id:
          data.vendorId && data.vendorId !== NO_VENDOR_VALUE ? data.vendorId : null,
        avg_lead_days: data.leadDays,
        unit_price_amount: data.unitPrice,
        units_per_package: data.unitsPerPackage,
        reorder_threshold: data.threshold,
        po_note: data.poNote ? data.poNote : null,
        notes: data.notes ? data.notes : null,
      });
      toast.success('Item created', {
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
            <DialogTitle>New inventory item</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
              <Field id="ni-itemId" label="Item #" error={errors.itemId?.message}>
                <Input
                  id="ni-itemId"
                  placeholder="e.g. UR-0001"
                  className="font-mono"
                  aria-invalid={Boolean(errors.itemId)}
                  {...register('itemId')}
                />
              </Field>
              <Field id="ni-desc" label="Description" error={errors.desc?.message}>
                <Input
                  id="ni-desc"
                  placeholder="e.g. CryoStor CS10, 100 mL Bottle"
                  aria-invalid={Boolean(errors.desc)}
                  {...register('desc')}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ni-vendor" label="Vendor" error={errors.vendorId?.message}>
                <Select
                  value={vendorId || ''}
                  onValueChange={(v) => setValue('vendorId', v, { shouldValidate: true })}
                  disabled={vendorsLoading || vendors.length === 0}
                >
                  <SelectTrigger id="ni-vendor" aria-invalid={Boolean(errors.vendorId)}>
                    <SelectValue
                      placeholder={
                        vendorsLoading
                          ? 'Loading vendors…'
                          : vendorsError
                            ? 'Could not load vendors'
                            : 'Select vendor'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={NO_VENDOR_VALUE}>— No vendor —</SelectItem>
                    {vendors.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id="ni-lead" label="Lead time (days)" error={errors.leadDays?.message}>
                <Input
                  id="ni-lead"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  {...register('leadDays')}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ni-price" label="Unit price" error={errors.unitPrice?.message}>
                <Input
                  id="ni-price"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  placeholder="0.00"
                  {...register('unitPrice')}
                />
              </Field>
              <Field
                id="ni-uperpkg"
                label="Units / package"
                error={errors.unitsPerPackage?.message}
              >
                <Input
                  id="ni-uperpkg"
                  type="number"
                  inputMode="numeric"
                  step="1"
                  min={1}
                  placeholder="e.g. 50"
                  {...register('unitsPerPackage')}
                />
              </Field>
            </div>

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
              <Field id="ni-po-note" label="PO note" error={errors.poNote?.message}>
                <Input
                  id="ni-po-note"
                  placeholder="e.g. Quote ref #1234"
                  {...register('poNote')}
                />
              </Field>
            </div>

            <Field id="ni-notes" label="Notes" error={errors.notes?.message}>
              <Textarea id="ni-notes" rows={3} {...register('notes')} />
            </Field>

            <p className="rounded-md border border-border bg-surface px-3 py-2.5 text-xs text-text-2">
              After creating, you’ll be able to record the first unit in to bring the
              item into stock. The item is initially created with zero balance.
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
              {busy ? 'Creating…' : 'Create item'}
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
