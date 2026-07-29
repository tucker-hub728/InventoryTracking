import { redirect } from 'next/navigation';

import { DEFAULT_FLOOR_TAB } from '@/components/production/floor-tabs';

/** A bare floor URL lands on the first tab, so `/production/{id}` is still a
 *  valid link to share. */
export default async function ProductionFloorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/production/${id}/${DEFAULT_FLOOR_TAB}`);
}
