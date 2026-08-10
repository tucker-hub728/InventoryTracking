import type { Metadata } from 'next';

import { ExpiringClient } from '@/components/consumables/expiring-client';

export const metadata: Metadata = {
  title: 'Expiring consumables',
};

/** The cross-Kanban expiration alert feed (REQ-2026-07-01-LOC-008). Per-room
 *  detail lives on each production area's Kanban tab. */
export default function ConsumablesPage() {
  return <ExpiringClient />;
}
