import type { Metadata } from 'next';

import { LocationSystemClient } from '@/components/locations/location-system-client';

export const metadata: Metadata = {
  title: 'LN2',
};

// The LN2 section reuses the existing location-system UI (LN2 storage
// hierarchy). Trimming it down to the hierarchy only — dropping the flat
// operational locations — is a follow-up pass.
export default function Ln2Page() {
  return <LocationSystemClient />;
}
