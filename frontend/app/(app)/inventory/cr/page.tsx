import type { Metadata } from 'next';

import { RawMaterialListClient } from '@/components/inventory/raw-material-list-client';

export const metadata: Metadata = {
  title: 'Raw Materials',
};

export default function RawMaterialsPage() {
  return <RawMaterialListClient />;
}
