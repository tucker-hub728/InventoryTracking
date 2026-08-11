import { Suspense } from 'react';
import type { Metadata } from 'next';

import { SuppliersDirectory } from '@/components/admin/suppliers/suppliers-directory';

export const metadata: Metadata = {
  title: 'Deactivated Suppliers',
};

export default function DeactivatedSuppliersPage() {
  return (
    <Suspense fallback={null}>
      <SuppliersDirectory isActive={false} />
    </Suspense>
  );
}
