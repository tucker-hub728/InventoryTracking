import { type ReactNode } from 'react';
import type { Metadata } from 'next';

import { InventoryDetailShell } from '@/components/inventory/inventory-detail-shell';

interface LayoutProps {
  children: ReactNode;
  params: { id: string };
}

export function generateMetadata({ params }: { params: { id: string } }): Metadata {
  return { title: `${params.id} · Inventory` };
}

export default function InventoryDetailLayout({ children, params }: LayoutProps) {
  return <InventoryDetailShell itemNumber={params.id}>{children}</InventoryDetailShell>;
}
