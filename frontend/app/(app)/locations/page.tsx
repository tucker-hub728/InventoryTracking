import type { Metadata } from 'next';

import { LocationsPageClient } from '@/components/admin/locations/locations-page-client';

export const metadata: Metadata = {
  title: 'Locations',
};

export default function LocationsPage() {
  return <LocationsPageClient />;
}
