import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { RoomClient } from '@/components/rooms/room-client';
import { COLD_STORAGE_ROOM } from '@/components/rooms/room-config';

export const metadata: Metadata = {
  title: 'Cold Storage',
};

/**
 * `/cold-storage` and `/cold-storage/{unitId}` both land here.
 *
 * The route exists so a refresh, a shared link or a bookmark can reopen a unit's
 * contents panel — it is NOT how the panel opens on click. See the note in
 * ``room-client.tsx``. The optional catch-all keeps both URLs on one file so the
 * id is a plain path segment rather than a query string.
 */
export default async function ColdStoragePage({
  params,
}: {
  params: Promise<{ node?: string[] }>;
}) {
  const { node } = await params;
  // Anything deeper than one id is not a URL we mint; fall back to the room.
  if (node && node.length > 1) {
    redirect(COLD_STORAGE_ROOM.href);
  }
  return <RoomClient room={COLD_STORAGE_ROOM} nodeId={node?.[0]} />;
}
