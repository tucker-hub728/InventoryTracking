import type { Metadata } from 'next';

import { KitDetailClient } from '@/components/reconciliation/kit-detail-client';

export const metadata: Metadata = { title: 'Kit' };

export default function KitDetailPage({ params }: { params: { id: string } }) {
  return <KitDetailClient kitId={params.id} />;
}
