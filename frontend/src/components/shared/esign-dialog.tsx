'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Lock, ShieldCheck } from 'lucide-react';

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
import { SignaturePad } from './signature-pad';
import { useAuthStore } from '@/stores/auth.store';

const schema = z
  .object({
    password: z.string().min(1, 'Password is required'),
    typedName: z.string().optional(),
    signatureData: z.string().optional(),
    intent: z.boolean(),
  })
  .refine((d) => Boolean(d.signatureData) || (d.typedName?.trim().length ?? 0) >= 2, {
    message: 'Provide a drawn signature or type your name',
    path: ['signatureData'],
  })
  .refine((d) => d.intent === true, {
    message: 'You must confirm the intent statement',
    path: ['intent'],
  });

export type ESignFormValues = z.infer<typeof schema>;

export interface ESignResult {
  password: string;
  typedName: string;
  signatureData: string;
  signedAt: string;
  signedBy: string;
}

export interface ESignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  meaning: string;
  /** Optional summary card content displayed above the form. */
  summary?: React.ReactNode;
  /** Called when the user signs successfully. */
  onSign: (result: ESignResult) => void | Promise<void>;
}

/**
 * Re-usable 21 CFR Part 11-compliant signing dialog.
 *
 * The form requires password + intent acknowledgement + either a drawn
 * signature or a typed full name (accessibility fallback). Submission
 * does NOT verify the password against a real backend (mock app), but
 * the form shape and audit metadata mirror what a real implementation
 * would record.
 */
export function ESignDialog({
  open,
  onOpenChange,
  title,
  meaning,
  summary,
  onSign,
}: ESignDialogProps) {
  const user = useAuthStore((s) => s.user);
  const [pending, setPending] = React.useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<ESignFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { intent: false, password: '', typedName: '', signatureData: '' },
  });

  React.useEffect(() => {
    if (!open) reset({ intent: false, password: '', typedName: '', signatureData: '' });
  }, [open, reset]);

  const intent = watch('intent') ?? false;

  const submit = async (data: ESignFormValues) => {
    if (!user) return;
    setPending(true);
    try {
      await onSign({
        password: data.password,
        typedName: data.typedName ?? '',
        signatureData: data.signatureData ?? '',
        signedAt: new Date().toISOString(),
        signedBy: user.name,
      });
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={handleSubmit(submit)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-accent" /> {title}
            </DialogTitle>
            <DialogDescription>{meaning}</DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-5">
            {summary && (
              <div className="rounded-md border border-border bg-surface p-3 text-xs">
                {summary}
              </div>
            )}

            <div className="space-y-2">
              <Label>Signature</Label>
              <SignaturePad
                onChange={(d) => setValue('signatureData', d, { shouldValidate: true })}
              />
              {errors.signatureData && (
                <p role="alert" className="text-xs text-danger">
                  {errors.signatureData.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="esign-typed-name">Or type your full name</Label>
              <Input
                id="esign-typed-name"
                placeholder={user?.name ?? 'Your full name'}
                {...register('typedName')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="esign-password">Password</Label>
              <Input
                id="esign-password"
                type="password"
                icon={Lock}
                autoComplete="current-password"
                aria-invalid={Boolean(errors.password)}
                {...register('password')}
              />
              {errors.password && (
                <p role="alert" className="text-xs text-danger">
                  {errors.password.message}
                </p>
              )}
            </div>

            <label className="flex items-start gap-2.5 rounded-md border border-border bg-bg-elev p-3 text-xs leading-snug text-text-2">
              <Checkbox
                checked={intent}
                onCheckedChange={(v) =>
                  setValue('intent', v === true, { shouldValidate: true })
                }
                aria-describedby="esign-intent-label"
                className="mt-0.5"
              />
              <span id="esign-intent-label">
                I confirm that my electronic signature represents{' '}
                <strong className="text-text">{meaning.toLowerCase()}</strong> and is the legally
                binding equivalent of my handwritten signature.
              </span>
            </label>
            {errors.intent && (
              <p role="alert" className="text-xs text-danger">
                {errors.intent.message}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? 'Signing…' : 'Sign'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
