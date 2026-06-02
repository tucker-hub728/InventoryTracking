import type { Metadata } from 'next';

import { UomsPageClient } from '@/components/admin/uoms/uoms-page-client';

export const metadata: Metadata = {
  title: 'Units of measure',
};

export default function UomsPage() {
  return <UomsPageClient />;
}
