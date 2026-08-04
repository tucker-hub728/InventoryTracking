import type { Metadata } from 'next';

import { ReceivingPageClient } from '@/components/inventory/receipt-admin/receiving-page-client';

export const metadata: Metadata = {
  title: 'Receipt Admin',
};

export default async function ReceivingOrderPage(
  props: {
    params: Promise<{ id: string }>;
  }
) {
  const params = await props.params;
  return <ReceivingPageClient initialOrderId={params.id} />;
}
