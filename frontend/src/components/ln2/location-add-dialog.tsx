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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LOCATION_KIND_OPTIONS, type LocationKind } from '@/lib/api/locations';
import { useLN2Store, type AddLocationInput } from '@/stores/ln2.store';
import { toast } from '@/components/ui/sonner';

const KIND_CODES = LOCATION_KIND_OPTIONS.map((o) => o.code) as [LocationKind, ...LocationKind[]];

const rackSchema = z.object({
  name: z.string().trim().min(1, 'Rack name is required').max(64),
  positions: z.coerce.number().int().min(1, 'Min 1').max(200),
});

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(128),
  kind: z.enum(KIND_CODES),
  detail: z.string().trim().max(128).optional(),
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
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      kind: 'LN2',
      detail: '',
      racks: [{ name: 'Rack 01', positions: 25 }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'racks' });
  const kind = watch('kind');

  React.useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const onSubmit = (values: FormValues): void => {
    const input: AddLocationInput = {
      name: values.name.trim(),
      kind: values.kind,
      detail:
        values.detail?.trim() ||
        LOCATION_KIND_OPTIONS.find((o) => o.code === values.kind)?.label ||
        '',
      racks: values.racks.map((r) => ({ name: r.name.trim(), positions: r.positions })),
    };
    const totalPositions = input.racks.reduce((sum, r) => sum + r.positions, 0);
    const id = addLocation(input);
    toast.success('Location added', {
      description: `${input.name} · ${input.racks.length} rack${input.racks.length === 1 ? '' : 's'} · ${totalPositions} positions`,
    });
    onCreated(id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Add location</DialogTitle>
            <DialogDescription>
              Every location uses the same rack → position layout. Define each rack below — its
              name and how many positions it holds.
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

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="loc-kind">
                  Kind <span className="text-danger">*</span>
                </Label>
                <Select
                  value={kind}
                  onValueChange={(v) =>
                    setValue('kind', v as LocationKind, { shouldValidate: true })
                  }
                >
                  <SelectTrigger id="loc-kind">
                    <SelectValue placeholder="Select kind" />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCATION_KIND_OPTIONS.map((o) => (
                      <SelectItem key={o.code} value={o.code}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="loc-detail">Detail</Label>
                <Input
                  id="loc-detail"
                  placeholder="e.g. -196 °C"
                  aria-invalid={Boolean(errors.detail)}
                  {...register('detail')}
                />
              </div>
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
                    append({ name: `Rack ${pad(fields.length + 1)}`, positions: 25 })
                  }
                >
                  <Plus size={13} /> Add rack
                </Button>
              </div>

              <div className="space-y-2">
                {/* Column headers */}
                <div className="grid grid-cols-[minmax(0,1fr)_7rem_2.25rem] gap-2 px-0.5 text-[11px] font-medium uppercase tracking-wider text-text-3">
                  <span>Rack name</span>
                  <span>Positions</span>
                  <span className="sr-only">Remove</span>
                </div>

                {fields.map((field, index) => (
                  <div key={field.id} className="space-y-1">
                    <div className="grid grid-cols-[minmax(0,1fr)_7rem_2.25rem] items-center gap-2">
                      <Input
                        placeholder={`Rack ${pad(index + 1)}`}
                        aria-label={`Rack ${index + 1} name`}
                        aria-invalid={Boolean(errors.racks?.[index]?.name)}
                        {...register(`racks.${index}.name`)}
                      />
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={200}
                        aria-label={`Rack ${index + 1} positions`}
                        aria-invalid={Boolean(errors.racks?.[index]?.positions)}
                        {...register(`racks.${index}.positions`)}
                      />
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
                    {(errors.racks?.[index]?.name || errors.racks?.[index]?.positions) && (
                      <p role="alert" className="px-0.5 text-xs text-danger">
                        {errors.racks?.[index]?.name?.message ??
                          errors.racks?.[index]?.positions?.message}
                      </p>
                    )}
                  </div>
                ))}

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
