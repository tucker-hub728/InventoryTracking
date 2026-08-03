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

interface LoginOkBody {
  user?: SessionUser;
  challenge?: 'NEW_PASSWORD_REQUIRED';
  email?: string;
}

// Self-service reset is live (/forgot-password → Cognito emails a code).
const SHOW_FORGOT_PASSWORD = true;

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
      // The backend now answers EVERY pre-auth failure with the single code
      // `invalid_credentials` — unknown address, wrong password and disabled
      // account are deliberately indistinguishable so the endpoint can't be
      // used to enumerate accounts. `authentication_required` is kept because
      // the BFF still returns it when there is no session at all.
      const message =
        body.code === 'invalid_credentials' ||
        body.code === 'authentication_required'
          ? 'Invalid email or password.'
          : (body.message ?? 'Sign-in failed. Please try again.');
      setSubmitError(message);
      return;
    }

    const body = (await resp.json()) as LoginOkBody;

    // First sign-in with a temporary password: no session yet — go set a real
    // one. The challenge itself is held server-side in an httpOnly cookie.
    if (body.challenge === 'NEW_PASSWORD_REQUIRED') {
      const email = body.email ?? data.email;
      router.replace(`/set-password?email=${encodeURIComponent(email)}`);
      return;
    }

    if (!body.user) {
      setSubmitError('Sign-in failed. Please try again.');
      return;
    }
    setSession(body.user);
    toast.success('Signed in', { description: `Welcome back, ${body.user.fullName}.` });

    // Only a path on THIS origin is an acceptable post-login destination.
    // `startsWith('/')` alone was not enough: "//evil.com" and "/\evil.com"
    // both start with a slash but are protocol-relative URLs, so the browser
    // would navigate off-site carrying the freshly-minted session.
    const next = params.get('next');
    const safeNext = next && /^\/(?![/\\])/.test(next) ? next : '/inventory';
    router.replace(safeNext);
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
