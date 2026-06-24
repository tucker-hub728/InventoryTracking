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
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/sonner';
import { useInventoryStore } from '@/stores/inventory.store';
import { ApiError } from '@/lib/api/client';
import { vendorsApi, type Vendor } from '@/lib/api/vendors';

import { VendorMultiSelect } from './vendor-multi-select';

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
  // Assigned vendors — zero-or-more. The only vendors this item can later be
  // received against. Optional: an item may start with none and add later.
  vendorIds: z.array(z.string()).default([]),
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
      vendorIds: [],
      leadDays: 0,
      threshold: 0,
      nearExpiryThresholdDays: 30,
    },
  });

  const vendorIds = watch('vendorIds');

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
        vendorIds: [],
        leadDays: 0,
        threshold: 0,
        nearExpiryThresholdDays: 30,
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
        vendor_ids: data.vendorIds,
        avg_lead_days: data.leadDays,
        reorder_threshold: data.threshold,
        near_expiry_threshold_days: data.nearExpiryThresholdDays,
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

            <Field
              id="ni-vendors"
              label="Vendors"
              error={errors.vendorIds?.message}
            >
              <VendorMultiSelect
                id="ni-vendors"
                vendors={vendors}
                value={vendorIds}
                onChange={(next) =>
                  setValue('vendorIds', next, { shouldValidate: true })
                }
                loading={vendorsLoading}
                error={vendorsError}
              />
              <p className="text-xs text-text-3">
                Only these vendors can be selected when receiving stock for this
                item.
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

            <div className="grid gap-4 sm:grid-cols-2">
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
