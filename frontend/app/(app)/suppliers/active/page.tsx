import { Suspense } from 'react';
import type { Metadata } from 'next';

import { SuppliersDirectory } from '@/components/admin/suppliers/suppliers-directory';

export const metadata: Metadata = {
  title: 'Active Suppliers',
};

export default function ActiveSuppliersPage() {
  // Suspense boundary: the directory reads page / size / search from
  // ``useSearchParams``, which bails the route out of static rendering
  // without one.
  return (
    <Suspense fallback={null}>
      <SuppliersDirectory isActive />
    </Suspense>
  );
}
