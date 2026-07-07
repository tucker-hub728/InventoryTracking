import type { Metadata } from 'next';

import { ItemsPageClient } from '@/components/inventory/items-page-client';

export const metadata: Metadata = {
  title: 'Raw Material Inventory (CR)',
};

export default function CrInventoryPage() {
  return <ItemsPageClient />;
}
