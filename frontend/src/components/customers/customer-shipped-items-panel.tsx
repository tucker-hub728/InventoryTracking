'use client';

/**
 * What a customer has been sent, rolled up by item — the answer to "how much of
 * what do we send them?".
 *
 * Unpaged by design: the rollup has one row per ITEM, and a customer takes a
 * handful of finished goods. Ordered by quantity rather than by name, so the
 * substance of the relationship is the first row rather than whatever sorts to
 * the top of the alphabet — which is also why the columns are only the facts
 * recorded: a proportion bar was tried here and removed, because at this row
 * count it restated the number beside it and read as a status it cannot be.
 *
 * Data comes from the shell rather than a fetch of its own — the summary band
 * above renders the same figures, and asking twice would show two spinners for
 * one answer.
 */

import * as React from 'react';

import { ItemLink } from '@/components/inventory/item-link';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import {
  formatDay,
  NeverShippedEmptyState,
  useCustomerDetail,
} from './customer-detail-shell';

export function CustomerShippedItemsPanel() {
  const { customer, shipped, shippedLoading, shippedError, reloadShipped } = useCustomerDetail();

  if (shippedError) {
    return (
      <div className="rounded-lg border border-border bg-bg-elev">
        <EmptyState
          title="Couldn’t load the shipping history"
          hint={shippedError}
          action={<Button onClick={reloadShipped}>Retry</Button>}
        />
      </div>
    );
  }

  if (shippedLoading && shipped === null) {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-bg-elev p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  const rows = shipped?.items ?? [];
  if (rows.length === 0) {
    return <NeverShippedEmptyState customerName={customer?.name ?? 'this customer'} />;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg-elev">
      <Table containerClassName="max-h-[65vh]">
        <TableHeader className="sticky top-0 z-10 bg-bg-elev">
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead className="text-right">Units shipped</TableHead>
            <TableHead className="text-right">Shipments</TableHead>
            <TableHead>Last shipped</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.item_id} className="hover:bg-surface/60">
              <TableCell className="max-w-[320px]">
                {r.item_number ? (
                  <ItemLink itemId={r.item_id} itemNumber={r.item_number} />
                ) : (
                  // Deleted out from under its own ledger rows. The units still
                  // left the building, so the row stays and says why.
                  <span className="text-text-3" title="This item has since been deleted">
                    Deleted item
                  </span>
                )}
                {r.item_description && (
                  <div className="truncate text-xs text-text-3">{r.item_description}</div>
                )}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {r.total_qty.toLocaleString()}
              </TableCell>
              {/* Same monospace digits as the column beside it. Two numeric
                  columns set in two different faces do not line up down the
                  page, and the eye reads that as a mistake before it reads the
                  number. Kept in the secondary ink so it still sits behind the
                  quantity in emphasis. */}
              <TableCell className="text-right font-mono tabular-nums text-text-2">
                {r.shipment_count.toLocaleString()}
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-text-2">
                {formatDay(r.last_shipped_at)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
