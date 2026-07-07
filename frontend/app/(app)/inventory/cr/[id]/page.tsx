import type { Metadata } from 'next';

import { ItemDetailClient } from '@/components/inventory/item-detail-client';

export const metadata: Metadata = {
  title: 'Raw Material',
};

export default function CrInventoryDetailPage({ params }: { params: { id: string } }) {
  return <ItemDetailClient itemId={params.id} />;
}
