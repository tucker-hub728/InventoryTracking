import type { Metadata } from 'next';

import { DebitAndGoneLocationClient } from '@/components/debit-and-gone/location-client';

export const metadata: Metadata = {
  title: 'Debit-and-gone',
};

/**
 * One debit-and-gone location's disposition log.
 *
 * ``/storage/{id}/issued`` redirects here, so links minted before this section
 * existed keep working.
 */
export default async function DebitAndGoneLocationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DebitAndGoneLocationClient nodeId={id} />;
}
