import type { Metadata } from 'next';

import { InventoryListClient } from '@/components/inventory/inventory-list-client';

export const metadata: Metadata = {
  title: 'Inventory',
};

export default function InventoryPage() {
  return <InventoryListClient />;
}
