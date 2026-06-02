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
import { vendorsApi, type Vendor, type VendorCreateInput } from '@/lib/api/vendors';

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

interface VendorCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (vendor: Vendor) => void;
}

export function VendorCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: VendorCreateDialogProps) {
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', contact_email: '', phone: '', notes: '' },
  });

  React.useEffect(() => {
    if (!open) {
      reset();
      setSubmitError(null);
    }
  }, [open, reset]);

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    const payload: VendorCreateInput = {
      name: values.name.trim(),
      contact_email: values.contact_email?.trim() || null,
      phone: values.phone?.trim() || null,
      notes: values.notes?.trim() || null,
    };
    try {
      const created = await vendorsApi.create(payload);
      onCreated(created);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'vendor_name_conflict') {
        setSubmitError(`A vendor named "${payload.name}" already exists.`);
        return;
      }
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to create vendor.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Add vendor</DialogTitle>
            <DialogDescription>
              Master data — used by the Vendor dropdown on inventory items and lots.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field
              id="vendor-name"
              label="Name"
              required
              error={errors.name?.message}
            >
              <Input
                id="vendor-name"
                autoComplete="organization"
                placeholder="e.g. Lonza Walkersville"
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
                  placeholder="orders@vendor.com"
                  aria-invalid={Boolean(errors.contact_email)}
                  {...register('contact_email')}
                />
              </Field>
              <Field id="vendor-phone" label="Phone">
                <Input
                  id="vendor-phone"
                  type="tel"
                  autoComplete="tel"
                  placeholder="+1 555 123 4567"
                  aria-invalid={Boolean(errors.phone)}
                  {...register('phone')}
                />
              </Field>
            </div>

            <Field id="vendor-notes" label="Notes">
              <Textarea
                id="vendor-notes"
                rows={3}
                placeholder="Account number, contract terms, anything operators should know."
                {...register('notes')}
              />
            </Field>

            <p className="rounded-md border border-border bg-surface px-3 py-2.5 text-xs text-text-2">
              The vendor becomes available immediately in the Item and Lot
              creation dropdowns. Every edit and deactivation is recorded
              to the audit log with the operator and a field-level diff.
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
            <Button type="button" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Add vendor'}
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
