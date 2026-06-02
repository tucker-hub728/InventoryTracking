import type { Metadata } from 'next';

import { UsersPageClient } from '@/components/users/users-page-client';

export const metadata: Metadata = {
  title: 'Users & Roles',
};

export default function UsersPage() {
  return <UsersPageClient />;
}
