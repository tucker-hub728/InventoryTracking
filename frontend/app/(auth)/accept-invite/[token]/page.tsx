import type { Metadata } from 'next';
import Link from 'next/link';

import { AcceptInviteForm } from '@/components/auth/accept-invite-form';
import { backend, BackendError } from '@/lib/auth/backend';

export const metadata: Metadata = {
  title: 'Accept invitation',
};

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  operator: 'Operator',
};

interface PageProps {
  params: { token: string };
}

export default async function AcceptInvitePage({ params }: PageProps) {
  const { token } = params;

  // Resolve the invitee server-side. A bad/expired/used token surfaces as a
  // BackendError (422) — we render a generic "invalid link" state rather than
  // leaking whether the token or email exists.
  let invitee: { firstName: string; email: string; roleLabel: string } | null = null;
  try {
    const inv = await backend.resolveInvite(token);
    invitee = {
      firstName: inv.first_name,
      email: inv.email,
      roleLabel: ROLE_LABEL[inv.role] ?? inv.role,
    };
  } catch (err) {
    // Only a 4xx (invalid / expired / used token) should render the generic
    // "unavailable" state below. A 5xx or non-backend error is a server
    // problem, not a bad invite — surface it via Next's error boundary rather
    // than misleading a legitimate invitee.
    if (!(err instanceof BackendError) || err.status >= 500) throw err;
  }

  return (
    <div className="grid min-h-screen place-items-center bg-bg px-4 py-10">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_30%,var(--accent-soft)_0%,transparent_60%)]" />
      {invitee ? (
        <AcceptInviteForm token={token} invitee={invitee} />
      ) : (
        <div className="mx-auto w-full max-w-md space-y-4 rounded-lg border border-border bg-bg-elev p-8 text-center shadow-elev-md">
          <h1 className="text-xl font-semibold tracking-tight">Invitation unavailable</h1>
          <p className="text-sm text-text-2">
            This invitation link is invalid, has expired, or has already been used. Ask an
            administrator to send you a new one.
          </p>
          <Link
            href="/login"
            className="inline-block text-sm text-accent hover:underline"
          >
            Go to sign in
          </Link>
        </div>
      )}
    </div>
  );
}
