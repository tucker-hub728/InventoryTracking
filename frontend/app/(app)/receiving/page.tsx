import type { Metadata } from 'next';

import { ReceivingPageClient } from '@/components/inventory/receipt-admin/receiving-page-client';

export const metadata: Metadata = {
  title: 'Receipt Admin',
};

export default function ReceivingPage() {
  return <ReceivingPageClient />;
}
