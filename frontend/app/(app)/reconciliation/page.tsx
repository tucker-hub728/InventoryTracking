import type { Metadata } from 'next';

import { ReconciliationPageClient } from '@/components/reconciliation/reconciliation-page-client';

export const metadata: Metadata = { title: 'Kitting & Reconciliation' };

export default function ReconciliationPage() {
  return <ReconciliationPageClient />;
}
