import { Suspense } from 'react';
import type { Metadata } from 'next';

import { UsersDirectory } from '@/components/admin/users-directory';

export const metadata: Metadata = {
  title: 'Active Members',
};

export default function ActiveMembersPage() {
  // The directory reads its page / size / search from ``useSearchParams``,
  // which needs a Suspense boundary or the whole route opts out of static
  // rendering at build time.
  return (
    <Suspense fallback={null}>
      <UsersDirectory
        isActive
        emptyTitle="No active members"
        emptyHint="Invite a user to get started."
      />
    </Suspense>
  );
}
