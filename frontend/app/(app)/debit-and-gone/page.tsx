import type { Metadata } from 'next';

import { DebitAndGoneClient } from '@/components/debit-and-gone/debit-and-gone-client';

export const metadata: Metadata = {
  title: 'Debit-and-gone',
};

/**
 * The debit-and-gone locations (REQ-2026-08-04-TRX-001/002).
 *
 * A filtered view of the Storage room's ``is_scrap`` locations — deliberately
 * NOT a room of its own. See the client for why that distinction matters.
 */
export default function DebitAndGonePage() {
  return <DebitAndGoneClient />;
}
