import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { RoomClient } from '@/components/rooms/room-client';
import { ANALYTICAL_LAB_ROOM } from '@/components/rooms/room-config';

export const metadata: Metadata = {
  title: 'Analytical Lab',
};

/**
 * `/analytical-lab` and `/analytical-lab/{unitId}` both land here — same pattern
 * as Cold Storage; see the note in ``room-client.tsx``.
 *
 * The room itself is provisional: REQ-2026-07-15-LOC-005 supersedes the only
 * requirement that placed freezers in the Analytical Lab and does not mention the
 * room. Kept at the client's direction (2026-07-30) — see ``room-config.ts``.
 */
export default async function AnalyticalLabPage({
  params,
}: {
  params: Promise<{ node?: string[] }>;
}) {
  const { node } = await params;
  if (node && node.length > 1) {
    redirect(ANALYTICAL_LAB_ROOM.href);
  }
  return <RoomClient room={ANALYTICAL_LAB_ROOM} nodeId={node?.[0]} />;
}
