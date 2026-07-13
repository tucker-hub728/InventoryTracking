'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AtSign, Eye, EyeOff, Lock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useAuthStore } from '@/stores/auth.store';
import { toast } from '@/components/ui/sonner';
import type { SessionUser } from '@/lib/auth/types';

const loginSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Invalid email'),
  password: z.string().min(1, 'Password is required'),
  remember: z.boolean().optional(),
});

type LoginValues = z.infer<typeof loginSchema>;

interface LoginErrorBody {
  code?: string;
  message?: string;
}

// Password reset isn't wired up yet — hide the "Forgot?" link for now.
// Flip to true to re-enable.
const SHOW_FORGOT_PASSWORD = false;

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const setSession = useAuthStore((s) => s.setSession);
  const clearSession = useAuthStore((s) => s.clear);
  const [showPw, setShowPw] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Bounced here because the account was deactivated mid-session — clear any
  // stale client state and explain why they were signed out.
  const deactivated = params.get('reason') === 'deactivated';
  React.useEffect(() => {
    if (deactivated) clearSession();
  }, [deactivated, clearSession]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: '',
      remember: true,
    },
  });

  const onSubmit = async (data: LoginValues): Promise<void> => {
    setSubmitError(null);
    const resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: data.email, password: data.password }),
      credentials: 'include',
    });

    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as LoginErrorBody;
      const message =
        body.code === 'authentication_required'
          ? 'Invalid email or password.'
          : (body.message ?? 'Sign-in failed. Please try again.');
      setSubmitError(message);
      return;
    }

    const { user } = (await resp.json()) as { user: SessionUser };
    setSession(user);
    toast.success('Signed in', { description: `Welcome back, ${user.fullName}.` });

    const next = params.get('next');
    router.replace(next && next.startsWith('/') ? next : '/inventory');
    // Refresh server components so the new cookies are picked up.
    router.refresh();
  };

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-text-2">
          Use your CellReady credentials.
        </p>
      </div>

      {deactivated && !submitError && (
        <p
          role="alert"
          className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning"
        >
          You were signed out because your account has been deactivated. Please contact an
          administrator.
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="login-email">Work email</Label>
        <Input
          id="login-email"
          type="email"
          icon={AtSign}
          autoComplete="username"
          placeholder="you@example.com"
          aria-invalid={Boolean(errors.email)}
          {...register('email')}
        />
        {errors.email && (
          <p role="alert" className="text-xs text-danger">
            {errors.email.message}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="login-password">Password</Label>
          {SHOW_FORGOT_PASSWORD && (
            <Link
              href="/forgot-password"
              className="text-xs text-accent hover:underline"
              tabIndex={-1}
            >
              Forgot?
            </Link>
          )}
        </div>
        <Input
          id="login-password"
          type={showPw ? 'text' : 'password'}
          icon={Lock}
          autoComplete="current-password"
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
        {errors.password && (
          <p role="alert" className="text-xs text-danger">
            {errors.password.message}
          </p>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs text-text-2">
        <Checkbox id="login-remember" {...register('remember')} />
        Remember this device for 30 days
      </label>

      {submitError && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
        >
          {submitError}
        </p>
      )}

      <Button type="submit" variant="primary" size="lg" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
