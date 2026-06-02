import type { Metadata } from 'next';

import { TankMapClient } from '@/components/ln2/tank-map-client';

export const metadata: Metadata = {
  title: 'Storage',
};

export default function LN2Page() {
  return <TankMapClient />;
}
