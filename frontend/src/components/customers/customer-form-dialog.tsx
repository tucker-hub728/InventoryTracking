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
import { Checkbox } from '@/components/ui/checkbox';
import { ApiError } from '@/lib/api/client';
import { itemsApi, type ApiItem } from '@/lib/api/items';
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

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

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
  // Finished-good (built) items a customer can be linked to.
  const [products, setProducts] = React.useState<ApiItem[]>([]);
  const [productsLoading, setProductsLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', contact_person: '', email: '' },
  });

  // Original linked set, to detect changes on edit.
  const originalIds = React.useMemo(
    () => new Set((customer?.items ?? []).map((p) => p.id)),
    [customer],
  );

  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setProductsLoading(true);
    itemsApi
      .list({ limit: 200 }, { signal: ctrl.signal })
      .then((resp) =>
        // Customers link to finished-good (Product / built) items only.
        setProducts(resp.items.filter((i) => i.category_kind === 'built')),
      )
      .catch(() => {})
      .finally(() => setProductsLoading(false));
    return () => ctrl.abort();
  }, [open]);

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
    setSelected(new Set((customer?.items ?? []).map((p) => p.id)));
    setSubmitError(null);
  }, [open, customer, reset]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
        if (!sameSet(selected, originalIds)) patch.item_ids = [...selected];
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
          item_ids: [...selected],
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
              Customer details and the finished goods they order.
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

            <div className="space-y-1.5">
              <Label>Linked finished goods</Label>
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {productsLoading ? (
                  <p className="px-2 py-3 text-center text-xs text-text-3">Loading items…</p>
                ) : products.length === 0 ? (
                  <p className="px-2 py-3 text-center text-xs text-text-3">
                    No Product items yet — create finished-good items first to link
                    them.
                  </p>
                ) : (
                  products.map((p) => (
                    <label
                      key={p.id}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-surface"
                    >
                      <Checkbox
                        checked={selected.has(p.id)}
                        onCheckedChange={() => toggle(p.id)}
                      />
                      <span className="font-mono text-xs text-text-2">
                        {p.item_number}
                      </span>
                      <span>{p.description}</span>
                    </label>
                  ))
                )}
              </div>
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
