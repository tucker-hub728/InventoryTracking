import type { Metadata } from 'next';

import { WarehouseClient } from '@/components/warehouse/warehouse-client';

export const metadata: Metadata = {
  title: 'Warehouse',
};

export default function WarehousePage() {
  return <WarehouseClient />;
}
