'use client';

import * as React from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Trash2 } from 'lucide-react';

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
import { useLN2Store, type AddLocationInput } from '@/stores/ln2.store';
import { toast } from '@/components/ui/sonner';

const rackSchema = z.object({
  name: z.string().trim().min(1, 'Rack name is required').max(64),
  rows: z.coerce.number().int().min(1, 'Min 1').max(26, 'Max 26'),
  cols: z.coerce.number().int().min(1, 'Min 1').max(26, 'Max 26'),
});

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(128),
  racks: z.array(rackSchema).min(1, 'Add at least one rack'),
});

type FormValues = z.infer<typeof schema>;

const pad = (n: number): string => String(n).padStart(2, '0');

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new location id so the caller can switch to it. */
  onCreated: (locationId: string) => void;
}

export function LocationAddDialog({ open, onOpenChange, onCreated }: Props) {
  const addLocation = useLN2Store((s) => s.addLocation);

  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      racks: [{ name: 'Rack 01', rows: 5, cols: 5 }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'racks' });
  const racks = watch('racks');

  React.useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const onSubmit = async (values: FormValues): Promise<void> => {
    const input: AddLocationInput = {
      name: values.name.trim(),
      racks: values.racks.map((r) => ({ name: r.name.trim(), rows: r.rows, cols: r.cols })),
    };
    const totalPositions = input.racks.reduce((sum, r) => sum + r.rows * r.cols, 0);
    try {
      const id = await addLocation(input);
      toast.success('Location added', {
        description: `${input.name} · ${input.racks.length} rack${input.racks.length === 1 ? '' : 's'} · ${totalPositions} positions`,
      });
      onCreated(id);
      onOpenChange(false);
    } catch (err) {
      toast.error('Could not add location', {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Add location</DialogTitle>
            <DialogDescription>
              Every location uses the same rack → position layout. Define each rack below — its
              name and grid size as rows × columns.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="loc-name">
                Name <span className="text-danger">*</span>
              </Label>
              <Input
                id="loc-name"
                placeholder="LN2 Tank D"
                aria-invalid={Boolean(errors.name)}
                {...register('name')}
              />
              {errors.name && (
                <p role="alert" className="text-xs text-danger">
                  {errors.name.message}
                </p>
              )}
            </div>

            {/* RACKS — dynamic field array */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>
                  Racks <span className="text-danger">*</span>
                </Label>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  onClick={() =>
                    append({ name: `Rack ${pad(fields.length + 1)}`, rows: 5, cols: 5 })
                  }
                >
                  <Plus size={13} /> Add rack
                </Button>
              </div>

              <div className="space-y-2">
                {/* Column headers */}
                <div className="grid grid-cols-[minmax(0,1fr)_auto_2.25rem] gap-2 px-0.5 text-[11px] font-medium uppercase tracking-wider text-text-3">
                  <span>Rack name</span>
                  <span>Grid (rows × cols)</span>
                  <span className="sr-only">Remove</span>
                </div>

                {fields.map((field, index) => {
                  const rows = Number(racks?.[index]?.rows) || 0;
                  const cols = Number(racks?.[index]?.cols) || 0;
                  const total = rows * cols;
                  return (
                    <div key={field.id} className="space-y-1">
                      <div className="grid grid-cols-[minmax(0,1fr)_auto_2.25rem] items-center gap-2">
                        <Input
                          placeholder={`Rack ${pad(index + 1)}`}
                          aria-label={`Rack ${index + 1} name`}
                          aria-invalid={Boolean(errors.racks?.[index]?.name)}
                          {...register(`racks.${index}.name`)}
                        />
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={26}
                            className="w-14 text-center"
                            aria-label={`Rack ${index + 1} rows`}
                            aria-invalid={Boolean(errors.racks?.[index]?.rows)}
                            {...register(`racks.${index}.rows`)}
                          />
                          <span className="text-xs text-text-3">×</span>
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={26}
                            className="w-14 text-center"
                            aria-label={`Rack ${index + 1} columns`}
                            aria-invalid={Boolean(errors.racks?.[index]?.cols)}
                            {...register(`racks.${index}.cols`)}
                          />
                          <span className="w-14 text-right font-mono text-[11px] text-text-3">
                            = {total}
                          </span>
                        </div>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove rack ${index + 1}`}
                          disabled={fields.length === 1}
                          onClick={() => remove(index)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                      {(errors.racks?.[index]?.name ||
                        errors.racks?.[index]?.rows ||
                        errors.racks?.[index]?.cols) && (
                        <p role="alert" className="px-0.5 text-xs text-danger">
                          {errors.racks?.[index]?.name?.message ??
                            errors.racks?.[index]?.rows?.message ??
                            errors.racks?.[index]?.cols?.message}
                        </p>
                      )}
                    </div>
                  );
                })}

                {errors.racks?.root && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.racks.root.message}
                  </p>
                )}
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={isSubmitting}>
              Add location
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
