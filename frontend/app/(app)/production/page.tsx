import type { Metadata } from 'next';

import { ProductionClient } from '@/components/production/production-client';

export const metadata: Metadata = {
  title: 'Production',
};

export default function ProductionPage() {
  return <ProductionClient />;
}
