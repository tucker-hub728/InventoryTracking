import type { Metadata } from 'next';

import { TierListClient } from '@/components/inventory/tier-list-client';
import { RAW_MATERIAL_TIER } from '@/config/tiers';

export const metadata: Metadata = {
  title: 'Raw Materials',
};

export default function RawMaterialsPage() {
  return <TierListClient config={RAW_MATERIAL_TIER} />;
}
