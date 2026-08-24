import type { Metadata } from 'next';

import { ReorderClient } from '@/components/planning/reorder-client';

export const metadata: Metadata = {
  title: 'Reorder · To receive',
};

/** Items below their threshold whose shortfall is already covered by a
 *  delivery sitting un-shelved (REQ-004). These need putting away, not
 *  ordering. */
export default function ReorderAwaitingPage() {
  return <ReorderClient group="awaiting" />;
}
