import type { Metadata } from 'next';

import { LotsPageClient } from '@/components/admin/lots/lots-page-client';

export const metadata: Metadata = {
  title: 'Lots',
};

export default function LotsPage() {
  return <LotsPageClient />;
}
