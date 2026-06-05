import { Suspense } from 'react';
import type { Metadata } from 'next';

import { TankMapClient } from '@/components/ln2/tank-map-client';

export const metadata: Metadata = {
  title: 'Storage',
};

export default function LN2Page() {
  // TankMapClient reads ?tab= via useSearchParams, which Next requires to sit
  // inside a Suspense boundary so the rest of the route can still prerender.
  return (
    <Suspense>
      <TankMapClient />
    </Suspense>
  );
}
