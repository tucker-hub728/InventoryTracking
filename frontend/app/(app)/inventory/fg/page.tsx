import type { Metadata } from 'next';

import { TierListClient } from '@/components/inventory/tier-list-client';
import { FINISHED_GOOD_TIER } from '@/config/tiers';

export const metadata: Metadata = {
  title: 'Finished Goods',
};

export default function FinishedGoodsPage() {
  return <TierListClient config={FINISHED_GOOD_TIER} />;
}
