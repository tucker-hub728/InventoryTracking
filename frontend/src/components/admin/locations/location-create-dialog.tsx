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
  type LocationCreateInput,
  type LocationKind,
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
  onCreated: (location: Location) => void;
}

export function LocationCreateDialog({ open, onOpenChange, onCreated }: Props) {
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
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
    if (!open) {
      reset();
      setSubmitError(null);
    }
  }, [open, reset]);

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    const payload: LocationCreateInput = {
      code: values.code.trim(),
      name: values.name.trim(),
      kind: values.kind,
      temperature_c: values.temperature_c ? Number(values.temperature_c) : null,
      notes: values.notes?.trim() || null,
    };
    try {
      const created = await locationsApi.create(payload);
      onCreated(created);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'location_code_conflict') {
        setSubmitError(`A location with code "${payload.code}" already exists.`);
        return;
      }
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to create location.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form noValidate onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Add location</DialogTitle>
            <DialogDescription>
              Storage position movements can reference (e.g. LN2-A, FRZ-80-B1).
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
                  placeholder="LN2-A"
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
                  placeholder="LN2 Tank A"
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
                  setValue('kind', v as LocationKind, { shouldValidate: true })
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
                placeholder="e.g. -196"
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
              {isSubmitting ? 'Saving…' : 'Add location'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
