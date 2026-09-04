import { Suspense } from 'react';
import type { Metadata } from 'next';

import { InvitationsPanel } from '@/components/admin/invitations-panel';

export const metadata: Metadata = {
  title: 'Invitations',
};

export default function InvitationsPage() {
  return (
    <Suspense fallback={null}>
      <InvitationsPanel />
    </Suspense>
  );
}
