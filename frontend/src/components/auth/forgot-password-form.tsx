'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, Eye, EyeOff, Lock, Mail, KeyRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { passwordStrength, PASSWORD_STRENGTH_LABELS } from '@/lib/password';
import { toast } from '@/components/ui/sonner';

// Same policy the set-password form enforces, so a password can't pass here and
// then be rejected by Cognito at submit.
const resetSchema = z
  .object({
    code: z.string().min(4, 'Enter the code from your email').max(32),
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

const requestSchema = z.object({ email: z.string().email('Enter a valid email address') });

type RequestValues = z.infer<typeof requestSchema>;
type ResetValues = z.infer<typeof resetSchema>;

interface ErrorBody {
  code?: string;
  message?: string;
}

/**
 * Two-step self-service reset, kept in one component so the email typed in step
 * one carries into step two without a page hop or a query param (which would put
 * the address in browser history and server logs).
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = React.useState<string | null>(null);

  return email === null ? (
    <RequestStep onSent={setEmail} />
  ) : (
    <ResetStep email={email} onBack={() => setEmail(null)} />
  );
}

function RequestStep({ onSent }: { onSent: (email: string) => void }) {
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RequestValues>({
    resolver: zodResolver(requestSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = async (data: RequestValues): Promise<void> => {
    setSubmitError(null);
    let resp: Response;
    try {
      resp = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.email }),
      });
    } catch {
      setSubmitError('Network error. Check your connection and try again.');
      return;
    }
    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as ErrorBody;
      setSubmitError(body.message ?? 'Could not start the reset. Please try again.');
      return;
    }
    // Advances on success regardless of whether the address exists — the backend
    // answers identically either way by design.
    onSent(data.email);
  };

  return (
    <Card
      eyebrow="Reset password"
      title="Forgot your password?"
      description="Enter your email and we'll send you a code to reset it."
    >
      <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="fp-email">Email</Label>
          <Input
            id="fp-email"
            type="email"
            icon={Mail}
            placeholder="you@cellready.com"
            autoComplete="email"
            autoFocus
            aria-invalid={Boolean(errors.email)}
            {...register('email')}
          />
          {errors.email && (
            <p role="alert" className="text-xs text-danger">
              {errors.email.message}
            </p>
          )}
        </div>

        {submitError && <ErrorNote>{submitError}</ErrorNote>}

        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Sending…' : 'Send reset code'}
        </Button>
        <BackToSignIn />
      </form>
    </Card>
  );
}

function ResetStep({ email, onBack }: { email: string; onBack: () => void }) {
  const router = useRouter();
  const [showPw, setShowPw] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { code: '', password: '', confirm: '' },
  });

  const strength = passwordStrength(watch('password') ?? '');

  const onSubmit = async (data: ResetValues): Promise<void> => {
    setSubmitError(null);
    let resp: Response;
    try {
      resp = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: data.code, password: data.password }),
      });
    } catch {
      setSubmitError('Network error. Check your connection and try again.');
      return;
    }

    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as ErrorBody;
      const message =
        body.code === 'validation_error' || body.code === 'invalid_password'
          ? (body.message ?? 'That code or password was not accepted.')
          : (body.message ?? 'Could not reset your password. Please try again.');
      setSubmitError(message);
      return;
    }

    toast.success('Password reset', { description: 'Sign in with your new password.' });
    router.replace('/login');
  };

  return (
    <Card
      eyebrow="Reset password"
      title="Enter your code"
      description={`We sent a code to ${email}. It expires shortly.`}
    >
      <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="fp-code">Reset code</Label>
          <Input
            id="fp-code"
            icon={KeyRound}
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
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
          <Label htmlFor="fp-pw">New password</Label>
          <Input
            id="fp-pw"
            type={showPw ? 'text' : 'password'}
            icon={Lock}
            autoComplete="new-password"
            aria-invalid={Boolean(errors.password)}
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
          <Label htmlFor="fp-pw2">Confirm new password</Label>
          <Input
            id="fp-pw2"
            type={showPw ? 'text' : 'password'}
            icon={Lock}
            autoComplete="new-password"
            aria-invalid={Boolean(errors.confirm)}
            {...register('confirm')}
          />
          {errors.confirm && (
            <p role="alert" className="text-xs text-danger">
              {errors.confirm.message}
            </p>
          )}
        </div>

        {submitError && <ErrorNote>{submitError}</ErrorNote>}

        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Resetting…' : 'Reset password'}
        </Button>

        <button
          type="button"
          onClick={onBack}
          className="w-full text-center text-xs text-text-3 transition-colors hover:text-text-2"
        >
          Use a different email
        </button>
      </form>
    </Card>
  );
}

function Card({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs font-semibold uppercase tracking-widest text-text-3">{eyebrow}</div>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-text-2">{description}</p>
      </div>
      {children}
    </div>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
    >
      {children}
    </p>
  );
}

function BackToSignIn() {
  return (
    <Link
      href="/login"
      className="flex items-center justify-center gap-1.5 text-xs text-text-3 transition-colors hover:text-text-2"
    >
      <ArrowLeft size={13} />
      Back to sign in
    </Link>
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
              i < score && (score >= 3 ? 'bg-success' : score === 2 ? 'bg-warning' : 'bg-danger'),
            )}
          />
        ))}
      </div>
      <div className="text-[11px] text-text-3">{label}</div>
    </div>
  );
}
