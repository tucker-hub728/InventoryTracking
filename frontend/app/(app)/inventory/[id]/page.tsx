import type { Metadata } from 'next';

import { InventoryDetailClient } from '@/components/inventory/inventory-detail-client';

interface PageProps {
  params: { id: string };
}

export function generateMetadata({ params }: PageProps): Metadata {
  return { title: `${params.id} · Inventory` };
}

export default function InventoryDetailPage({ params }: PageProps) {
  return <InventoryDetailClient itemNumber={params.id} />;
}
