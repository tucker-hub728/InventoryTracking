import { Suspense } from 'react';
import type { Metadata } from 'next';

import { AuditPageClient } from '@/components/admin/audit/audit-page-client';

export const metadata: Metadata = {
  title: 'Audit log',
};

export default function AuditPage() {
  // The viewer keeps its filters and page in the query string via
  // ``useSearchParams``, which needs a Suspense boundary here.
  return (
    <Suspense fallback={null}>
      <AuditPageClient />
    </Suspense>
  );
}
