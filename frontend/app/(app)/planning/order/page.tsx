import type { Metadata } from 'next';

import { ReorderClient } from '@/components/planning/reorder-client';

export const metadata: Metadata = {
  title: 'Reorder · To order',
};

/** Items below their threshold with nothing on site to cover them — these need
 *  a purchase order (PLN-001). */
export default function ReorderOrderPage() {
  return <ReorderClient group="order" />;
}
