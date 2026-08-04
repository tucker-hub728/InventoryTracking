import { type ReactNode } from 'react';
import type { Metadata } from 'next';

import { InventoryDetailShell } from '@/components/inventory/inventory-detail-shell';

interface LayoutProps {
  children: ReactNode;
  params: Promise<{ id: string }>;
}

// The route segment is the item's UUID, which is meaningless as a tab title —
// the shell renders the real SKU in the page header once the item loads.
export function generateMetadata(): Metadata {
  return { title: 'Item · Inventory' };
}

export default async function InventoryDetailLayout(props: LayoutProps) {
  const params = await props.params;

  const {
    children
  } = props;

  return <InventoryDetailShell itemKey={params.id}>{children}</InventoryDetailShell>;
}
