import type { Metadata } from 'next';

import { FreezerClient } from '@/components/freezer/freezer-client';

export const metadata: Metadata = {
  title: 'Freezers',
};

export default function FreezerPage() {
  return <FreezerClient />;
}
