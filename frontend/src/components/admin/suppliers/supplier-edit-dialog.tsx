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
import { ApiError } from '@/lib/api/client';
import { suppliersApi, type Supplier, type SupplierUpdateInput } from '@/lib/api/suppliers';

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(128),
  contact_email: z
    .string()
    .email('Not a valid email')
    .max(320)
    .optional()
    .or(z.literal('')),
  phone: z.string().max(64).optional(),
  notes: z.string().max(2048).optional(),
  // A string, so clearing the box (→ null, "not recorded") stays distinct from
  // typing 0 (→ same-day delivery). Bounds match the API and the DB CHECK.
  lead_time_days: z
    .string()
    .optional()
    .refine(
      (v) => !v || (/^\d+$/.test(v) && Number(v) >= 0 && Number(v) <= 3650),
      'Whole number of days, 0–3650',
    ),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier: Supplier | null;
  onUpdated: (supplier: Supplier) => void;
}

export function SupplierEditDialog({ open, onOpenChange, supplier, onUpdated }: Props) {
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      contact_email: '',
      phone: '',
      notes: '',
      lead_time_days: '',
    },
  });

  React.useEffect(() => {
    if (open && supplier) {
      reset({
        name: supplier.name,
        contact_email: supplier.contact_email ?? '',
        phone: supplier.phone ?? '',
        notes: supplier.notes ?? '',
        // `?? ''` not `|| ''` — a stored 0 is a real lead time and must show
        // as "0", not as an empty (unrecorded) box.
        lead_time_days: supplier.lead_time_days != null ? String(supplier.lead_time_days) : '',
      });
      setSubmitError(null);
    }
  }, [open, supplier, reset]);

  const onSubmit = async (values: FormValues): Promise<void> => {
    if (!supplier) return;
    setSubmitError(null);

    // Build the minimal PATCH from dirty fields only. Sending the full
    // form would write a useless full-row diff into the audit log.
    const patch: SupplierUpdateInput = {};
    if (dirtyFields.name) patch.name = values.name.trim();
    if (dirtyFields.contact_email) patch.contact_email = values.contact_email?.trim() || null;
    if (dirtyFields.phone) patch.phone = values.phone?.trim() || null;
    if (dirtyFields.notes) patch.notes = values.notes?.trim() || null;
    if (dirtyFields.lead_time_days) {
      // Cleared → null ("not recorded"). Typed 0 → 0 (same-day). The trim-then-
      // check keeps those two apart; `|| null` would collapse "0" into null.
      const raw = values.lead_time_days?.trim() ?? '';
      patch.lead_time_days = raw === '' ? null : Number(raw);
    }

    if (Object.keys(patch).length === 0) {
      setSubmitError('No changes to save.');
      return;
    }

    try {
      const updated = await suppliersApi.update(supplier.id, patch);
      onUpdated(updated);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'supplier_name_conflict') {
        setSubmitError(`A supplier named "${patch.name}" already exists.`);
        return;
      }
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to update supplier.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Edit supplier</DialogTitle>
            <DialogDescription>
              Every field-level change is recorded to the audit log with
              the operator and a before/after diff.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field id="supplier-name" label="Name" required error={errors.name?.message}>
              <Input
                id="supplier-name"
                autoComplete="organization"
                aria-invalid={Boolean(errors.name)}
                {...register('name')}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="supplier-email"
                label="Contact email"
                error={errors.contact_email?.message}
              >
                <Input
                  id="supplier-email"
                  type="email"
                  autoComplete="email"
                  aria-invalid={Boolean(errors.contact_email)}
                  {...register('contact_email')}
                />
              </Field>
              <Field id="supplier-phone" label="Phone">
                <Input
                  id="supplier-phone"
                  type="tel"
                  autoComplete="tel"
                  {...register('phone')}
                />
              </Field>
            </div>

            <Field
              id="supplier-lead"
              label="Lead time (days)"
              error={errors.lead_time_days?.message}
              hint="Order to delivery. Empty means not confirmed yet — the reorder screen shows that as unknown rather than assuming no wait."
            >
              <Input
                id="supplier-lead"
                inputMode="numeric"
                placeholder="e.g. 30"
                aria-invalid={Boolean(errors.lead_time_days)}
                {...register('lead_time_days')}
              />
            </Field>

            <Field id="supplier-notes" label="Notes">
              <Textarea id="supplier-notes" rows={3} {...register('notes')} />
            </Field>

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

function Field({
  id,
  label,
  required,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label} {required && <span className="text-danger">*</span>}
      </Label>
      {children}
      {hint && !error && <p className="text-xs text-text-3">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
