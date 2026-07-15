'use client';

import * as React from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';

interface Props {
  /** Item *number* — plain text is rendered when absent. */
  itemNumber: string | null | undefined;
  className?: string;
}

/**
 * An item number that navigates to that item's ledger.
 *
 * `/inventory/[id]` keys on the human item number, not the UUID — the shell
 * resolves it with `itemsApi.getByNumber` and `notFound()`s on a miss — so the
 * href builds straight from the number with no lookup. It is encoded because
 * item numbers are free text.
 */
export function ItemLink({ itemNumber, className }: Props) {
  if (!itemNumber) return <span className={className}>—</span>;

  return (
    <Link
      href={`/inventory/${encodeURIComponent(itemNumber)}/ledger`}
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
