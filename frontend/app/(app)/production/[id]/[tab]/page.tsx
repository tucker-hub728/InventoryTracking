import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { DEFAULT_FLOOR_TAB, FLOOR_TAB_SEGMENTS } from '@/components/production/floor-tabs';
import { ProductionFloorClient } from '@/components/production/production-floor-client';

export const metadata: Metadata = {
  title: 'Production floor',
};

/** One production floor, one tab per URL: `/production/{id}/in-production`,
 *  `/consumed`, `/cancelled` (client 2026-07-28). An unknown segment redirects
 *  to the first tab rather than rendering an empty page. */
export default async function ProductionFloorTabPage({
  params,
}: {
  params: Promise<{ id: string; tab: string }>;
}) {
  const { id, tab } = await params;
  if (!FLOOR_TAB_SEGMENTS.includes(tab)) {
    redirect(`/production/${id}/${DEFAULT_FLOOR_TAB}`);
  }
  return <ProductionFloorClient nodeId={id} tab={tab} />;
}
