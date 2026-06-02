'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { useAuthStore } from '@/stores/auth.store';

/**
 * Client-side gate for app routes.
 *
 * Edge middleware has already done a cheap presence-check for the refresh
 * cookie, so by the time we render here a session *probably* exists. This
 * component hydrates the store from /api/auth/me on mount — the backend
 * call is authoritative — and bounces to /login if it comes back null.
 *
 * Children only render when a user is present, so feature components can
 * rely on ``useAuthStore`` being populated.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const hydrate = useAuthStore((s) => s.hydrate);

  React.useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  React.useEffect(() => {
    if (hydrated && !user) router.replace('/login');
  }, [hydrated, user, router]);

  if (!hydrated || !user) return null;
  return <>{children}</>;
}
