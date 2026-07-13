import type { Metadata } from 'next';

import { AcceptInviteForm } from '@/components/auth/accept-invite-form';
import { backend, BackendError } from '@/lib/auth/backend';

export const metadata: Metadata = {
  title: 'Accept invitation',
};

interface PageProps {
  params: { token: string };
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super administrator',
  admin: 'Administrator',
  editor: 'Editor',
  viewer: 'Read-only',
};

export default async function AcceptInvitePage({ params }: PageProps) {
  // Resolve the invite server-side so the accept screen shows the real invitee
  // (name / email / role) instead of a placeholder. A bad/expired token yields
  // a generic "invalid link" screen — no email enumeration.
  let invitee: { firstName: string; email: string; roleLabel: string } | null = null;
  try {
    const view = await backend.resolveInvite(params.token);
    invitee = {
      firstName: view.first_name,
      email: view.email,
      roleLabel: ROLE_LABELS[view.role] ?? view.role,
    };
  } catch (err) {
    if (!(err instanceof BackendError)) throw err;
    invitee = null;
  }

  return (
    <div className="grid min-h-screen place-items-center bg-bg px-4 py-10">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_30%,var(--accent-soft)_0%,transparent_60%)]" />
      {invitee ? (
        <AcceptInviteForm token={params.token} invitee={invitee} />
      ) : (
        <div className="mx-auto w-full max-w-md space-y-3 rounded-lg border border-border bg-bg-elev p-8 text-center shadow-elev-md">
          <h1 className="text-xl font-semibold tracking-tight">Invitation not found</h1>
          <p className="text-sm text-text-2">
            This invitation link is invalid or has expired. Ask an administrator to send you a new
            one.
          </p>
        </div>
      )}
    </div>
  );
}
