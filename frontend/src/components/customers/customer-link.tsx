'use client';

import * as React from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';

interface Props {
  /** Customer *name* — the visible text. Plain text is rendered when absent. */
  customerName: string | null | undefined;
  /** Customer UUID. Without it there is nothing to link to and the name renders
   *  as plain text: `/customers/[id]` keys on the UUID, and a name is not a
   *  stable address — the client renames customers. */
  customerId?: string | null;
  className?: string;
}

/**
 * A customer name that navigates to that customer's shipping history.
 *
 * The ledger's sibling columns already work this way — the lot opens what
 * created it (``LotLink``), the item opens its ledger (``ItemLink``) — so a
 * customer that was the one piece of plain text in the row read as a dead end.
 * It is the same question the others answer: "what else do I know about this?"
 *
 * Renders plain text rather than a broken link when the id is missing. That is
 * not hypothetical: ``customer_id`` is nullable on the ledger, so legacy
 * catalog-era shipments (written before the customer became required) carry a
 * name-less, id-less recipient, and a soft-deleted customer keeps its name on
 * the row it shipped on. The append-only ledger means those rows outlive the
 * master data they point at, and the column must keep rendering when they do.
 */
export function CustomerLink({ customerName, customerId, className }: Props) {
  if (!customerName) return <span className={className}>—</span>;

  if (!customerId) {
    return (
      <span className={cn('truncate', className)} title={customerName}>
        {customerName}
      </span>
    );
  }

  return (
    <Link
      href={`/customers/${customerId}`}
      // Several call sites sit inside rows that have their own click handler.
      onClick={(e) => e.stopPropagation()}
      title={`Open the shipping history for ${customerName}`}
      className={cn(
        'truncate rounded-sm text-accent underline-offset-2 transition-opacity hover:underline hover:opacity-80',
        className,
      )}
    >
      {customerName}
    </Link>
  );
}
