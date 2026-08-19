import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { StorageCategoryClient } from '@/components/storage/storage-category-client';
import { DEFAULT_GROUP_SEGMENT, isStorageSegment } from '@/components/storage/storage-groups';

export const metadata: Metadata = {
  title: 'Storage',
};

/**
 * Both `/storage/{id}/shf` and `/storage/{id}/shf/{nodeId}` land here.
 *
 * This route exists so a refresh, a shared link or a bookmark can reopen a
 * unit's panel — it is NOT how the panel opens on click. Clicking rewrites the
 * address bar with ``window.history.pushState`` inside the client, because
 * routing here would change a dynamic segment's value, and changing a dynamic
 * segment's key unmounts the page subtree and remounts it — refetching the tree
 * on every click.
 *
 * The segment is validated against the SHAPE of a Storage URL — a template
 * sub-type, an added one (`grp-2`), or the scrap location's disposition log —
 * not against this location's own tabs: whether a location actually has that tab
 * is a question about data, which the server component has not loaded. The
 * client redirects to the first tab the location does have.
 *
 * It is a PATTERN and not a fixed list because sub-types are added at runtime
 * (LOC-001, 2026-08-13). A list of known segments would have bounced every
 * `/storage/{id}/grp-2` link to the default tab on refresh — the tab would work
 * until you reloaded the page.
 */
export default async function StorageCategoryPage({
  params,
}: {
  params: Promise<{ id: string; tab: string; node?: string[] }>;
}) {
  const { id, tab, node } = await params;
  if (!isStorageSegment(tab)) {
    redirect(`/storage/${id}/${DEFAULT_GROUP_SEGMENT}`);
  }
  // Anything deeper than one id is not a URL we mint; fall back to the tab.
  if (node && node.length > 1) {
    redirect(`/storage/${id}/${tab}`);
  }
  return <StorageCategoryClient categoryId={id} segment={tab} nodeId={node?.[0]} />;
}
