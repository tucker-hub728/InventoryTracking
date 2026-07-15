import type { Metadata } from 'next';

import { ReceivingPageClient } from '@/components/inventory/receipt-admin/receiving-page-client';

export const metadata: Metadata = {
  title: 'Receipt Admin',
};

export default function ReceivingOrderPage({
  params,
}: {
  params: { id: string };
}) {
  return <ReceivingPageClient initialOrderId={params.id} />;
}
