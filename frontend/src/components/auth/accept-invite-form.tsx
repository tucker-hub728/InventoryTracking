'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Lock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { passwordStrength, PASSWORD_STRENGTH_LABELS } from '@/lib/password';
import { toast } from '@/components/ui/sonner';

const schema = z
  .object({
    password: z
      .string()
      .min(8, 'At least 8 characters')
      .refine((v) => /[A-Z]/.test(v) && /\d/.test(v), {
        message: 'Mix uppercase letters and digits',
      }),
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });

type Values = z.infer<typeof schema>;

interface Props {
  token: string;
  invitee: {
    name: string;
    email: string;
    role: string;
  };
}

export function AcceptInviteForm({ token, invitee }: Props) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '' },
  });

  const pw = watch('password');
  const strength = passwordStrength(pw ?? '');

  const onSubmit = async (_data: Values): Promise<void> => {
    // Demo: don't persist anything. Real flow would POST to /api/auth/accept-invite.
    await new Promise((r) => setTimeout(r, 350));
    toast.success('Account created', {
      description: 'Your account is ready. Please sign in.',
    });
    router.replace('/login');
  };

  return (
    <div className="mx-auto w-full max-w-md space-y-6 rounded-lg border border-border bg-bg-elev p-8 shadow-elev-md">
      <div>
        <div className="text-xs font-semibold uppercase tracking-widest text-text-3">
          Accept invitation · #{token.slice(0, 8)}
        </div>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Welcome, {invitee.name}</h1>
        <p className="mt-1 text-sm text-text-2">
          You’ve been invited as a <strong className="text-text">{invitee.role}</strong>.
          Set a password to activate your account.
        </p>
      </div>

      <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1.5">
          <Label>Email</Label>
          <Input value={invitee.email} disabled readOnly />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="acc-pw">New password</Label>
          <Input
            id="acc-pw"
            type="password"
            icon={Lock}
            aria-invalid={Boolean(errors.password)}
            autoComplete="new-password"
            {...register('password')}
          />
          <StrengthMeter score={strength} />
          {errors.password && (
            <p role="alert" className="text-xs text-danger">
              {errors.password.message}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="acc-pw2">Confirm password</Label>
          <Input
            id="acc-pw2"
            type="password"
            icon={Lock}
            aria-invalid={Boolean(errors.confirm)}
            autoComplete="new-password"
            {...register('confirm')}
          />
          {errors.confirm && (
            <p role="alert" className="text-xs text-danger">
              {errors.confirm.message}
            </p>
          )}
        </div>

        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Activating…' : 'Activate account'}
        </Button>
      </form>
    </div>
  );
}

function StrengthMeter({ score }: { score: number }) {
  const label = PASSWORD_STRENGTH_LABELS[score] ?? '';
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex gap-1" role="meter" aria-valuemin={0} aria-valuemax={4} aria-valuenow={score}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              'h-1 flex-1 rounded-full bg-surface-2 transition-colors',
              i < score &&
                (score >= 3 ? 'bg-success' : score === 2 ? 'bg-warning' : 'bg-danger'),
            )}
          />
        ))}
      </div>
      <div className="text-[11px] text-text-3">{label}</div>
    </div>
  );
}
