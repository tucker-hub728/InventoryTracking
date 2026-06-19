import type { Metadata } from 'next';

import { LocationSystemClient } from '@/components/locations/location-system-client';

export const metadata: Metadata = {
  title: 'Locations',
};

export default function LocationsPage() {
  return <LocationSystemClient />;
}
