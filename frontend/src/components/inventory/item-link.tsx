'use client';

import * as React from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';

interface Props {
  /** Item *number* — the visible text. Plain text is rendered when absent. */
  itemNumber: string | null | undefined;
  /** Item UUID. Strongly preferred: `/inventory/[id]` keys on the UUID, so
   *  passing it links straight to the canonical URL. Without it the link falls
   *  back to the number, which still resolves but costs an extra redirect
   *  (and the number changes whenever its prefix is renamed). */
  itemId?: string | null;
  className?: string;
}

/**
 * An item number that navigates to that item's ledger.
 *
 * `/inventory/[id]` keys on the item's stable UUID. Pass `itemId` wherever it
 * is available so the link lands directly; the number-based href is only a
 * compatibility fallback (the detail shell resolves it and rewrites the URL).
 */
export function ItemLink({ itemNumber, itemId, className }: Props) {
  if (!itemNumber) return <span className={className}>—</span>;

  const href = itemId
    ? `/inventory/${itemId}/ledger`
    : `/inventory/${encodeURIComponent(itemNumber)}/ledger`;

  return (
    <Link
      href={href}
      // Several call sites sit inside rows that have their own click handler.
      onClick={(e) => e.stopPropagation()}
      title={`Open the ledger for ${itemNumber}`}
      className={cn(
        'rounded-sm text-accent underline-offset-2 transition-opacity hover:underline hover:opacity-80',
        className,
      )}
    >
      {itemNumber}
    </Link>
  );
}
