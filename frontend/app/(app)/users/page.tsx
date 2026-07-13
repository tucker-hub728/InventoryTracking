import type { Metadata } from 'next';

import { UsersPageClient } from '@/components/admin/users-page-client';

export const metadata: Metadata = {
  title: 'Users',
};

export default function UsersPage() {
  return <UsersPageClient />;
}
