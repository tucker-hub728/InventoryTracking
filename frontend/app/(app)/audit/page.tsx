import type { Metadata } from 'next';

import { AuditPageClient } from '@/components/admin/audit/audit-page-client';

export const metadata: Metadata = {
  title: 'Audit log',
};

export default function AuditPage() {
  return <AuditPageClient />;
}
