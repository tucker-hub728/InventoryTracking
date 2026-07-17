import type { Metadata } from 'next';

import { TiersPageClient } from '@/components/tiers/tiers-page-client';

export const metadata: Metadata = {
  title: 'Item Tiers',
};

export default function TiersPage() {
  return <TiersPageClient />;
}
