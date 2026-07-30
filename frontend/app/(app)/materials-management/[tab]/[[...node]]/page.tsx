import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import {
  DEFAULT_MM_TAB,
  MM_TAB_SEGMENTS,
} from '@/components/materials-management/mm-tabs';
import { MaterialsManagementClient } from '@/components/materials-management/materials-management-client';

export const metadata: Metadata = {
  title: 'Materials Management',
};

/**
 * Both `/materials-management/warehouse` and
 * `/materials-management/cold-storage/{id}` land here.
 *
 * This route exists so a refresh, a shared link or a bookmark can reopen a
 * shelf/unit panel — it is NOT how the panel opens on click. Clicking rewrites
 * the address bar with ``window.history.pushState`` inside the client, because
 * routing here would change a dynamic segment's value, and changing a dynamic
 * segment's key unmounts the page subtree and remounts it — refetching both
 * trees on every click.
 *
 * The optional catch-all keeps both URLs on one file so the id is a plain path
 * segment rather than a query string.
 */
export default async function MaterialsManagementPage({
  params,
}: {
  params: Promise<{ tab: string; node?: string[] }>;
}) {
  const { tab, node } = await params;
  if (!MM_TAB_SEGMENTS.includes(tab)) {
    redirect(`/materials-management/${DEFAULT_MM_TAB}`);
  }
  // Anything deeper than one id is not a URL we mint; fall back to the tab.
  if (node && node.length > 1) {
    redirect(`/materials-management/${tab}`);
  }
  return <MaterialsManagementClient tab={tab} nodeId={node?.[0]} />;
}
