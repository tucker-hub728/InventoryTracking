import type { Metadata } from 'next';

import { TierListClient } from '@/components/inventory/tier-list-client';
import { SUB_ASSEMBLY_TIER } from '@/config/tiers';

export const metadata: Metadata = {
  title: 'Sub-Assemblies',
};

export default function SubAssembliesPage() {
  return <TierListClient config={SUB_ASSEMBLY_TIER} />;
}
