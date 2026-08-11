import { Suspense } from 'react';
import type { Metadata } from 'next';

import { UsersDirectory } from '@/components/admin/users-directory';

export const metadata: Metadata = {
  title: 'Inactive Members',
};

export default function InactiveMembersPage() {
  return (
    <Suspense fallback={null}>
      <UsersDirectory
        isActive={false}
        emptyTitle="No inactive members"
        emptyHint="Deactivated users appear here."
      />
    </Suspense>
  );
}
