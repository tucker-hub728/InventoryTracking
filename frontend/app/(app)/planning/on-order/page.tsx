import type { Metadata } from 'next';

import { ReorderClient } from '@/components/planning/reorder-client';

export const metadata: Metadata = {
  title: 'Reorder · On order',
};

/** Items below their threshold that already have an open purchase order
 *  covering the shortfall. They stay visible — an order can be late — but they
 *  do not belong under a heading telling anyone to buy more. */
export default function ReorderOnOrderPage() {
  return <ReorderClient group="on_order" />;
}
