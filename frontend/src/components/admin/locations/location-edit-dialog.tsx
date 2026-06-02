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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import {
  locationsApi,
  LOCATION_KIND_OPTIONS,
  type Location,
  type LocationKind,
  type LocationUpdateInput,
} from '@/lib/api/locations';

const KIND_CODES = LOCATION_KIND_OPTIONS.map((o) => o.code) as [
  LocationKind,
  ...LocationKind[],
];

const schema = z.object({
  code: z.string().trim().min(1, 'Code is required').max(64),
  name: z.string().trim().min(1, 'Name is required').max(128),
  kind: z.enum(KIND_CODES),
  temperature_c: z
    .string()
    .optional()
    .refine(
      (v) => !v || (/^-?\d+(\.\d+)?$/.test(v) && Number(v) >= -273 && Number(v) <= 100),
      'Temperature must be between -273 °C and 100 °C',
    ),
  notes: z.string().max(2048).optional(),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: Location | null;
  onUpdated: (location: Location) => void;
}

/**
 * Partial-update dialog for an existing storage location. Same fields
 * as create + dirty-field PATCH so the audit log shows only what
 * actually changed.
 */
export function LocationEditDialog({ open, onOpenChange, location, onUpdated }: Props) {
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      code: '',
      name: '',
      kind: 'minus_80',
      temperature_c: '',
      notes: '',
    },
  });

  const kind = watch('kind');

  React.useEffect(() => {
    if (open && location) {
      reset({
        code: location.code,
        name: location.name,
        kind: location.kind,
        temperature_c: location.temperature_c ?? '',
        notes: location.notes ?? '',
      });
      setSubmitError(null);
    }
  }, [open, location, reset]);

  const onSubmit = async (values: FormValues): Promise<void> => {
    if (!location) return;
    setSubmitError(null);

    const patch: LocationUpdateInput = {};
    if (dirtyFields.code) patch.code = values.code.trim();
    if (dirtyFields.name) patch.name = values.name.trim();
    if (dirtyFields.kind) patch.kind = values.kind;
    if (dirtyFields.temperature_c) {
      patch.temperature_c = values.temperature_c ? Number(values.temperature_c) : null;
    }
    if (dirtyFields.notes) patch.notes = values.notes?.trim() || null;

    if (Object.keys(patch).length === 0) {
      setSubmitError('No changes to save.');
      return;
    }

    try {
      const updated = await locationsApi.update(location.id, patch);
      onUpdated(updated);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'location_code_conflict') {
        setSubmitError(`A location with code "${patch.code}" already exists.`);
        return;
      }
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to update location.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Edit location</DialogTitle>
            <DialogDescription>
              Every change is recorded to the audit log with the operator
              and a field-level diff.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="loc-code">
                  Code <span className="text-danger">*</span>
                </Label>
                <Input
                  id="loc-code"
                  className="font-mono"
                  aria-invalid={Boolean(errors.code)}
                  {...register('code')}
                />
                {errors.code && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.code.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="loc-name">
                  Name <span className="text-danger">*</span>
                </Label>
                <Input
                  id="loc-name"
                  aria-invalid={Boolean(errors.name)}
                  {...register('name')}
                />
                {errors.name && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.name.message}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="loc-kind">
                Kind <span className="text-danger">*</span>
              </Label>
              <Select
                value={kind}
                onValueChange={(v) =>
                  setValue('kind', v as LocationKind, {
                    shouldValidate: true,
                    shouldDirty: true,
                  })
                }
              >
                <SelectTrigger id="loc-kind" aria-invalid={Boolean(errors.kind)}>
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
              <Label htmlFor="loc-temp">Temperature (°C)</Label>
              <Input
                id="loc-temp"
                type="number"
                inputMode="decimal"
                step="0.1"
                aria-invalid={Boolean(errors.temperature_c)}
                {...register('temperature_c')}
              />
              {errors.temperature_c && (
                <p role="alert" className="text-xs text-danger">
                  {errors.temperature_c.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="loc-notes">Notes</Label>
              <Input id="loc-notes" {...register('notes')} />
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
              {isSubmitting ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
