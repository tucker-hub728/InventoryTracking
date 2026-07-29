import type { Metadata } from 'next';

import { LocationSystemClient } from '@/components/locations/location-system-client';

export const metadata: Metadata = {
  title: 'LN2',
};

/**
 * The LN2 storage hierarchy, with the selected cascade in the URL:
 * `/ln2/{tank}/{quadrant}/{rack}/{box}`.
 *
 * The whole chain is spelled out rather than just the selected id — the URL
 * then reads as the physical address, and a shared link says where in the tank
 * to look. Only the LAST segment drives selection; the ancestors above it are
 * derivable from the tree and are there for humans.
 *
 * An OPTIONAL CATCH-ALL, so `/ln2` and any depth under it resolve to this one
 * file. Selection itself never routes: clicking a node rewrites the address bar
 * with `window.history.pushState` inside the client, because changing a dynamic
 * segment's value remounts the page subtree and would refetch the whole tree on
 * every click. This route exists for arriving from outside — refresh, a
 * bookmark, a shared link.
 */
export default async function Ln2Page({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path } = await params;
  return <LocationSystemClient initialPath={path ?? []} />;
}
