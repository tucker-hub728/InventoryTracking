'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Package } from 'lucide-react';

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
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { formatNumber } from '@/lib/utils';
import { STOCK_STATUS_META } from '@/config/inventory';
import { itemsApi, type ApiItem } from '@/lib/api/items';
import {
  materialsApi,
  type MaterialCreateInput,
  type ProductMaterial,
} from '@/lib/api/products';

const MAX_QTY = 5000;

const schema = z.object({
  item_id: z.string().uuid('Pick a material'),
  qty_per_run: z.coerce
    .number()
    .int('Whole numbers only')
    .positive('Must be greater than 0')
    .max(MAX_QTY, `Max ${MAX_QTY}`),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  /** When set, edits this material (qty only); otherwise adds a new one. */
  material?: ProductMaterial;
  /** Item IDs already in the BOM — hidden from the add picker. */
  excludeItemIds?: string[];
  onSaved: () => void;
}

export function MaterialFormDialog({
  open,
  onOpenChange,
  productId,
  material,
  excludeItemIds = [],
  onSaved,
}: Props) {
  const isEdit = Boolean(material);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<ApiItem[]>([]);
  const [itemsLoading, setItemsLoading] = React.useState(false);
  const [itemsError, setItemsError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { item_id: '', qty_per_run: 1 },
  });

  const itemId = watch('item_id');

  React.useEffect(() => {
    if (!open || isEdit) return;
    const ctrl = new AbortController();
    setItemsLoading(true);
    setItemsError(null);
    itemsApi
      .list({ limit: 200, sort: 'item_number', direction: 'asc' }, { signal: ctrl.signal })
      .then((resp) => setItems(resp.items))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setItemsError(err instanceof ApiError ? err.message : 'Failed to load materials.');
      })
      .finally(() => setItemsLoading(false));
    return () => ctrl.abort();
  }, [open, isEdit]);

  React.useEffect(() => {
    if (!open) return;
    reset(
      material
        ? { item_id: material.item_id, qty_per_run: Number(material.qty_per_run) }
        : { item_id: '', qty_per_run: 1 },
    );
    setSubmitError(null);
  }, [open, material, reset]);

  const pickable = React.useMemo(
    () => items.filter((i) => !excludeItemIds.includes(i.id)),
    [items, excludeItemIds],
  );

  // Unit label for the qty suffix (from the edited material or the picked item).
  const uom = isEdit
    ? material?.uom_code
    : items.find((i) => i.id === itemId)?.uom_code;

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    try {
      if (material) {
        await materialsApi.update(material.id, { qty_per_run: values.qty_per_run });
      } else {
        const input: MaterialCreateInput = {
          item_id: values.item_id,
          qty_per_run: values.qty_per_run,
        };
        await materialsApi.add(productId, input);
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'material_conflict') {
          setSubmitError('That material is already on this product.');
          return;
        }
        setSubmitError(err.message);
        return;
      }
      setSubmitError('Failed to save material.');
    }
  };

  const statusMeta = material ? STOCK_STATUS_META[material.status_code] : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit material' : 'Add required material'}</DialogTitle>
            <DialogDescription>
              An inventory item consumed per production run.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {isEdit && material ? (
              // ── Locked item: a clean card, not a disabled-looking input ──
              <div className="rounded-lg border border-border bg-surface p-3">
                <div className="flex items-center gap-3">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                    <Package size={17} aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-semibold text-accent">
                      {material.item_number}
                    </div>
                    <div className="truncate text-sm text-text" title={material.item_name}>
                      {material.item_name}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5 text-xs">
                  <span className="text-text-3">
                    Available:{' '}
                    <span className="font-mono text-text-2">
                      {formatNumber(Number(material.qty_available))}
                    </span>{' '}
                    {material.uom_code}
                  </span>
                  {statusMeta && (
                    <Badge tone={statusMeta.tone} dot>
                      {statusMeta.label}
                    </Badge>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="mat-item">
                  Inventory item <span className="text-danger">*</span>
                </Label>
                <Select
                  value={itemId || ''}
                  onValueChange={(v) => setValue('item_id', v, { shouldValidate: true })}
                  disabled={itemsLoading || pickable.length === 0}
                >
                  <SelectTrigger id="mat-item" aria-invalid={Boolean(errors.item_id)}>
                    <SelectValue
                      placeholder={
                        itemsLoading
                          ? 'Loading items…'
                          : itemsError
                            ? 'Could not load items'
                            : items.length > 0 && pickable.length === 0
                              ? 'All inventory items are already added to this product'
                              : pickable.length === 0
                                ? 'No inventory items available'
                                : 'Select item'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {pickable.map((i) => (
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
            )}

            <div className="space-y-1.5">
              <Label htmlFor="mat-qty">
                Qty per production run <span className="text-danger">*</span>
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="mat-qty"
                  type="number"
                  inputMode="numeric"
                  step="1"
                  min={1}
                  max={MAX_QTY}
                  className="flex-1 font-mono"
                  aria-invalid={Boolean(errors.qty_per_run)}
                  {...register('qty_per_run')}
                />
                {uom && <span className="shrink-0 text-sm text-text-3">{uom} / run</span>}
              </div>
              {errors.qty_per_run && (
                <p role="alert" className="text-xs text-danger">
                  {errors.qty_per_run.message}
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
              {isSubmitting ? 'Saving…' : isEdit ? 'Save changes' : 'Add material'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
