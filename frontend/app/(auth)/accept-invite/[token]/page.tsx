import type { Metadata } from 'next';

import { AcceptInviteForm } from '@/components/auth/accept-invite-form';

export const metadata: Metadata = {
  title: 'Accept invitation',
};

interface PageProps {
  params: { token: string };
}

export default function AcceptInvitePage({ params }: PageProps) {
  // Demo: in a real app we'd resolve the invitee from the server using the token.
  const invitee = {
    name: 'Lena Forsberg',
    email: 'lena.forsberg@cellready.com',
    role: 'Read-only',
  };

  return (
    <div className="grid min-h-screen place-items-center bg-bg px-4 py-10">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_30%,var(--accent-soft)_0%,transparent_60%)]" />
      <AcceptInviteForm token={params.token} invitee={invitee} />
    </div>
  );
}
