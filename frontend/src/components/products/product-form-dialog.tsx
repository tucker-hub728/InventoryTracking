'use client';

import * as React from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Trash2 } from 'lucide-react';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { itemsApi, type ApiItem } from '@/lib/api/items';
import { productsApi, type Product, type ProductCreateInput } from '@/lib/api/products';

const MAX_QTY = 5000;

const materialRow = z.object({
  item_id: z.string().uuid('Pick a material'),
  qty_per_run: z.coerce
    .number()
    .int('Whole numbers only')
    .positive('Qty must be > 0')
    .max(MAX_QTY, `Max ${MAX_QTY}`),
});

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  sku: z.string().trim().min(1, 'SKU is required').max(64),
  materials: z.array(materialRow),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, edits the product (name only); otherwise creates one. */
  product?: Product;
  onSaved: (product: Product) => void;
}

export function ProductFormDialog({ open, onOpenChange, product, onSaved }: Props) {
  const isEdit = Boolean(product);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<ApiItem[]>([]);
  const [itemsLoading, setItemsLoading] = React.useState(false);

  const {
    register,
    handleSubmit,
    reset,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', sku: '', materials: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'materials' });
  const rows = watch('materials');

  // Load the material (inventory item) picker — create mode only.
  React.useEffect(() => {
    if (!open || isEdit) return;
    const ctrl = new AbortController();
    setItemsLoading(true);
    itemsApi
      .list({ limit: 200, sort: 'item_number', direction: 'asc' }, { signal: ctrl.signal })
      .then((resp) => setItems(resp.items))
      .catch(() => {})
      .finally(() => setItemsLoading(false));
    return () => ctrl.abort();
  }, [open, isEdit]);

  React.useEffect(() => {
    if (!open) return;
    reset(
      product
        ? { name: product.name, sku: product.sku, materials: [] }
        : { name: '', sku: '', materials: [] },
    );
    setSubmitError(null);
  }, [open, product, reset]);

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    try {
      let saved: Product;
      if (product) {
        saved = await productsApi.update(product.id, { name: values.name.trim() });
      } else {
        const input: ProductCreateInput = {
          name: values.name.trim(),
          sku: values.sku.trim(),
          materials: values.materials.map((m) => ({
            item_id: m.item_id,
            qty_per_run: m.qty_per_run,
          })),
        };
        saved = await productsApi.create(input);
      }
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'product_name_conflict') {
          setSubmitError(`A product named "${values.name.trim()}" already exists.`);
          return;
        }
        if (err.code === 'product_sku_conflict') {
          setSubmitError(`SKU "${values.sku.trim()}" is already in use.`);
          return;
        }
        if (err.code === 'duplicate_material') {
          setSubmitError('The same material appears more than once — remove the duplicate.');
          return;
        }
        setSubmitError(err.message);
        return;
      }
      setSubmitError(isEdit ? 'Failed to update product.' : 'Failed to create product.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit product' : 'New product'}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'Rename the product. Materials are managed on the product page.'
                : 'Name the product and list the materials consumed per production run.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="prod-sku">
                SKU <span className="text-danger">*</span>
              </Label>
              {isEdit ? (
                <>
                  <div className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text-2">
                    {product?.sku}
                  </div>
                  <p className="text-xs text-text-3">
                    The SKU can&apos;t be changed after creation.
                  </p>
                </>
              ) : (
                <>
                  <Input
                    id="prod-sku"
                    placeholder="e.g. PRD-001"
                    className="font-mono"
                    aria-invalid={Boolean(errors.sku)}
                    {...register('sku')}
                  />
                  {errors.sku && (
                    <p role="alert" className="text-xs text-danger">
                      {errors.sku.message}
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prod-name">
                Product name <span className="text-danger">*</span>
              </Label>
              <Input
                id="prod-name"
                placeholder="e.g. CAR-T Cell Therapy Batch"
                aria-invalid={Boolean(errors.name)}
                {...register('name')}
              />
              {errors.name && (
                <p role="alert" className="text-xs text-danger">
                  {errors.name.message}
                </p>
              )}
            </div>

            {!isEdit && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Required materials per production run</Label>
                  <Button
                    type="button"
                    variant="default"
                    className="h-8 px-2"
                    onClick={() => append({ item_id: '', qty_per_run: 1 })}
                  >
                    <Plus size={14} /> Add material
                  </Button>
                </div>

                {fields.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-3">
                    No materials yet. Add the inventory items this product consumes (optional —
                    you can also add them later on the product page).
                  </p>
                ) : (
                  <div className="space-y-2">
                    {fields.map((field, index) => {
                      // Hide items already chosen in OTHER rows so the same
                      // material can't be added twice.
                      const otherIds = new Set(
                        (rows ?? [])
                          .filter((_, idx) => idx !== index)
                          .map((r) => r?.item_id)
                          .filter((v): v is string => Boolean(v)),
                      );
                      const options = items.filter((i) => !otherIds.has(i.id));
                      return (
                        <div key={field.id} className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <Select
                              value={rows?.[index]?.item_id || ''}
                              onValueChange={(v) =>
                                setValue(`materials.${index}.item_id`, v, {
                                  shouldValidate: true,
                                })
                              }
                              disabled={itemsLoading || items.length === 0}
                            >
                              <SelectTrigger
                                aria-invalid={Boolean(errors.materials?.[index]?.item_id)}
                              >
                                <SelectValue
                                  placeholder={itemsLoading ? 'Loading…' : 'Select material'}
                                />
                              </SelectTrigger>
                              <SelectContent className="max-h-72">
                                {options.map((i) => (
                                  <SelectItem key={i.id} value={i.id}>
                                    <span className="font-mono text-xs">{i.item_number}</span>
                                    <span className="ml-2 text-text-2">{i.description}</span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {errors.materials?.[index]?.item_id && (
                              <p role="alert" className="mt-1 text-xs text-danger">
                                {errors.materials[index]?.item_id?.message}
                              </p>
                            )}
                          </div>
                          <div className="w-28">
                            <Input
                              type="number"
                              inputMode="numeric"
                              step="1"
                              min={1}
                              max={MAX_QTY}
                              className="font-mono"
                              placeholder="Qty/run"
                              aria-invalid={Boolean(errors.materials?.[index]?.qty_per_run)}
                              {...register(`materials.${index}.qty_per_run`)}
                            />
                            {errors.materials?.[index]?.qty_per_run && (
                              <p role="alert" className="mt-1 text-xs text-danger">
                                {errors.materials[index]?.qty_per_run?.message}
                              </p>
                            )}
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-9 px-2 text-danger"
                            onClick={() => remove(index)}
                            aria-label="Remove material"
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

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
              {isSubmitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create product'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
