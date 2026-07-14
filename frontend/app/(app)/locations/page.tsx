import { redirect } from 'next/navigation';

// The combined Locations page moved under the new Locations section — its
// tree UI now lives at /ln2. Kept as a redirect so old bookmarks resolve.
export default function LocationsPage() {
  redirect('/ln2');
}
