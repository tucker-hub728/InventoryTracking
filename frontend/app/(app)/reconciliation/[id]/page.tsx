import type { Metadata } from 'next';

import { KitDetailClient } from '@/components/reconciliation/kit-detail-client';

export const metadata: Metadata = { title: 'Kit' };

export default async function KitDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return <KitDetailClient kitId={params.id} />;
}
