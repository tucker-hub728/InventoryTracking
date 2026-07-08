'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, Lock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { passwordStrength, PASSWORD_STRENGTH_LABELS } from '@/lib/password';
import { toast } from '@/components/ui/sonner';
import { useAuthStore } from '@/stores/auth.store';
import type { SessionUser } from '@/lib/auth/types';

// Mirrors the production Cognito pool policy (min 12 + all character classes)
// so the invitee never passes client validation only to be rejected by
// Cognito at submit. Dev cognito-local (min 8) accepts these too.
const schema = z
  .object({
    password: z
      .string()
      .min(12, 'At least 12 characters')
      .refine((v) => /[A-Z]/.test(v), 'Add an uppercase letter')
      .refine((v) => /[a-z]/.test(v), 'Add a lowercase letter')
      .refine((v) => /\d/.test(v), 'Add a number')
      .refine((v) => /[^A-Za-z0-9]/.test(v), 'Add a symbol'),
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
    firstName: string;
    email: string;
    roleLabel: string;
  };
}

interface AcceptErrorBody {
  code?: string;
  message?: string;
}

export function AcceptInviteForm({ token, invitee }: Props) {
  const router = useRouter();
  const setSession = useAuthStore((s) => s.setSession);
  const [showPw, setShowPw] = React.useState(false);
  const [showConfirm, setShowConfirm] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

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

  const onSubmit = async (data: Values): Promise<void> => {
    setSubmitError(null);
    let resp: Response;
    try {
      resp = await fetch('/api/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: data.password }),
        credentials: 'include',
      });
    } catch {
      // Network failure on a one-shot flow — the invite isn't consumed on the
      // server, so tell the user to retry rather than leaving them stuck.
      setSubmitError('Network error. Check your connection and try again.');
      return;
    }

    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as AcceptErrorBody;
      const message =
        body.code === 'invite_invalid'
          ? 'This invitation link is invalid or has already been used.'
          : body.code === 'invite_expired'
            ? 'This invitation link has expired. Ask an admin to resend it.'
            : (body.message ?? 'Could not activate your account. Please try again.');
      setSubmitError(message);
      return;
    }

    const { user } = (await resp.json()) as { user: SessionUser };
    setSession(user);
    toast.success('Account activated', { description: `Welcome, ${invitee.firstName}.` });
    router.replace('/inventory/cr');
    // Refresh server components so the new session cookies are picked up.
    router.refresh();
  };

  return (
    <div className="mx-auto w-full max-w-md space-y-6 rounded-lg border border-border bg-bg-elev p-8 shadow-elev-md">
      <div>
        <div className="text-xs font-semibold uppercase tracking-widest text-text-3">
          Accept invitation
        </div>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Welcome, {invitee.firstName}</h1>
        <p className="mt-1 text-sm text-text-2">
          You’ve been invited as a <strong className="text-text">{invitee.roleLabel}</strong>. Set a
          password to activate your account.
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
            type={showPw ? 'text' : 'password'}
            icon={Lock}
            aria-invalid={Boolean(errors.password)}
            autoComplete="new-password"
            trailing={
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                className="text-text-3 transition-colors hover:text-text-2"
              >
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            }
            {...register('password')}
          />
          <StrengthMeter score={strength} />
          {errors.password ? (
            <p role="alert" className="text-xs text-danger">
              {errors.password.message}
            </p>
          ) : (
            <p className="text-xs text-text-3">
              At least 12 characters with uppercase, lowercase, a number and a symbol.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="acc-pw2">Confirm password</Label>
          <Input
            id="acc-pw2"
            type={showConfirm ? 'text' : 'password'}
            icon={Lock}
            aria-invalid={Boolean(errors.confirm)}
            autoComplete="new-password"
            trailing={
              <button
                type="button"
                onClick={() => setShowConfirm((v) => !v)}
                aria-label={showConfirm ? 'Hide password' : 'Show password'}
                className="text-text-3 transition-colors hover:text-text-2"
              >
                {showConfirm ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            }
            {...register('confirm')}
          />
          {errors.confirm && (
            <p role="alert" className="text-xs text-danger">
              {errors.confirm.message}
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
