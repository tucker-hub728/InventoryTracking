import type { Metadata } from 'next';

import { SetPasswordForm } from '@/components/auth/set-password-form';

export const metadata: Metadata = {
  title: 'Set your password',
};

interface PageProps {
  // Display-only hint carried over from login; the authoritative email + session
  // live in the httpOnly challenge cookie the BFF reads.
  searchParams: { email?: string };
}

export default function SetPasswordPage({ searchParams }: PageProps) {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-4 py-10">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_30%,var(--accent-soft)_0%,transparent_60%)]" />
      <SetPasswordForm email={searchParams.email ?? ''} />
    </div>
  );
}
