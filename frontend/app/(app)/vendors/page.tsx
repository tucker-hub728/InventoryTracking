import type { Metadata } from 'next';

import { VendorsPageClient } from '@/components/admin/vendors/vendors-page-client';

export const metadata: Metadata = {
  title: 'Vendors',
};

export default function VendorsPage() {
  return <VendorsPageClient />;
}
