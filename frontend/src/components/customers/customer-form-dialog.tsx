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
import { ApiError } from '@/lib/api/client';
import {
  customersApi,
  type Customer,
  type CustomerCreateInput,
  type CustomerUpdateInput,
} from '@/lib/api/customers';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  contact_person: z.string().max(200).optional(),
  email: z
    .string()
    .max(320)
    .optional()
    .refine((v) => !v || /\S+@\S+\.\S+/.test(v), 'Enter a valid email'),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, edits this customer; otherwise creates one. */
  customer?: Customer;
  onSaved: (customer: Customer) => void;
}

export function CustomerFormDialog({ open, onOpenChange, customer, onSaved }: Props) {
  const isEdit = Boolean(customer);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', contact_person: '', email: '' },
  });

  React.useEffect(() => {
    if (!open) return;
    reset(
      customer
        ? {
            name: customer.name,
            contact_person: customer.contact_person ?? '',
            email: customer.email ?? '',
          }
        : { name: '', contact_person: '', email: '' },
    );
    setSubmitError(null);
  }, [open, customer, reset]);

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    try {
      let saved: Customer;
      if (customer) {
        const patch: CustomerUpdateInput = {};
        if (dirtyFields.name) patch.name = values.name.trim();
        if (dirtyFields.contact_person)
          patch.contact_person = values.contact_person?.trim() || null;
        if (dirtyFields.email) patch.email = values.email?.trim() || null;
        if (Object.keys(patch).length === 0) {
          setSubmitError('No changes to save.');
          return;
        }
        saved = await customersApi.update(customer.id, patch);
      } else {
        const input: CustomerCreateInput = {
          name: values.name.trim(),
          contact_person: values.contact_person?.trim() || null,
          email: values.email?.trim() || null,
        };
        saved = await customersApi.create(input);
      }
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'customer_name_conflict') {
          setSubmitError(`A customer named "${values.name.trim()}" already exists.`);
          return;
        }
        setSubmitError(err.message);
        return;
      }
      setSubmitError(isEdit ? 'Failed to update customer.' : 'Failed to create customer.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit customer' : 'Add customer'}</DialogTitle>
            <DialogDescription>
              Customer details. Finished goods are shipped to a customer at the point of
              the shipment.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cust-name">
                Customer name <span className="text-danger">*</span>
              </Label>
              <Input
                id="cust-name"
                placeholder="e.g. BioGenesis Labs"
                aria-invalid={Boolean(errors.name)}
                {...register('name')}
              />
              {errors.name && (
                <p role="alert" className="text-xs text-danger">
                  {errors.name.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cust-contact">Contact name</Label>
              <Input
                id="cust-contact"
                placeholder="e.g. Jane Doe"
                aria-invalid={Boolean(errors.contact_person)}
                {...register('contact_person')}
              />
              {errors.contact_person && (
                <p role="alert" className="text-xs text-danger">
                  {errors.contact_person.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cust-email">Email</Label>
              <Input
                id="cust-email"
                type="email"
                placeholder="email@company.com"
                aria-invalid={Boolean(errors.email)}
                {...register('email')}
              />
              {errors.email && (
                <p role="alert" className="text-xs text-danger">
                  {errors.email.message}
                </p>
              )}
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
              {isSubmitting ? 'Saving…' : isEdit ? 'Save changes' : 'Add customer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
