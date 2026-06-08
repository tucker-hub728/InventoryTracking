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
import { vendorsApi, type Vendor, type VendorUpdateInput } from '@/lib/api/vendors';

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
});

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendor: Vendor | null;
  onUpdated: (vendor: Vendor) => void;
}

export function VendorEditDialog({ open, onOpenChange, vendor, onUpdated }: Props) {
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
    },
  });

  React.useEffect(() => {
    if (open && vendor) {
      reset({
        name: vendor.name,
        contact_email: vendor.contact_email ?? '',
        phone: vendor.phone ?? '',
        notes: vendor.notes ?? '',
      });
      setSubmitError(null);
    }
  }, [open, vendor, reset]);

  const onSubmit = async (values: FormValues): Promise<void> => {
    if (!vendor) return;
    setSubmitError(null);

    // Build the minimal PATCH from dirty fields only. Sending the full
    // form would write a useless full-row diff into the audit log.
    const patch: VendorUpdateInput = {};
    if (dirtyFields.name) patch.name = values.name.trim();
    if (dirtyFields.contact_email) patch.contact_email = values.contact_email?.trim() || null;
    if (dirtyFields.phone) patch.phone = values.phone?.trim() || null;
    if (dirtyFields.notes) patch.notes = values.notes?.trim() || null;

    if (Object.keys(patch).length === 0) {
      setSubmitError('No changes to save.');
      return;
    }

    try {
      const updated = await vendorsApi.update(vendor.id, patch);
      onUpdated(updated);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'vendor_name_conflict') {
        setSubmitError(`A vendor named "${patch.name}" already exists.`);
        return;
      }
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to update vendor.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Edit vendor</DialogTitle>
            <DialogDescription>
              Every field-level change is recorded to the audit log with
              the operator and a before/after diff.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field id="vendor-name" label="Name" required error={errors.name?.message}>
              <Input
                id="vendor-name"
                autoComplete="organization"
                aria-invalid={Boolean(errors.name)}
                {...register('name')}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="vendor-email"
                label="Contact email"
                error={errors.contact_email?.message}
              >
                <Input
                  id="vendor-email"
                  type="email"
                  autoComplete="email"
                  aria-invalid={Boolean(errors.contact_email)}
                  {...register('contact_email')}
                />
              </Field>
              <Field id="vendor-phone" label="Phone">
                <Input
                  id="vendor-phone"
                  type="tel"
                  autoComplete="tel"
                  {...register('phone')}
                />
              </Field>
            </div>

            <Field id="vendor-notes" label="Notes">
              <Textarea id="vendor-notes" rows={3} {...register('notes')} />
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
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label} {required && <span className="text-danger">*</span>}
      </Label>
      {children}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
