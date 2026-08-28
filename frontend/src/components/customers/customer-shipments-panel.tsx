'use client';

/**
 * A customer's shipment history — what left, and when.
 *
 * One row per SHIPMENT, not per ledger row. A multi-source ship posts a movement
 * per source lot in one transaction; the API folds them back into the single
 * signed action they were, and the lots appear as lines inside the row. That is
 * the grain the ship dialog posted in, so the history reads the way the work
 * happened rather than the way the ledger stores it.
 *
 * Server-paged on EVENTS, so the pager's total matches the rows on screen.
 *
 * Read-only, and structurally so (CUST-003): there is no row action, no edit and
 * no delete, because the ledger underneath refuses all three — a wrong shipment
 * is corrected with a new entry, never by rewriting this one.
 */

import * as React from 'react';
import { PackageX } from 'lucide-react';

import { LocationPath } from '@/components/locations/location-path';
import { ItemLink } from '@/components/inventory/item-link';
import { LotLink } from '@/components/inventory/lot-link';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { NumberedPagination } from '@/components/ui/numbered-pagination';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/api/client';
import { shipmentsApi, type CustomerShipments } from '@/lib/api/shipments';

import { formatWhen, NeverShippedEmptyState, useCustomerDetail } from './customer-detail-shell';

const PAGE_SIZES = [10, 25, 50, 100];

export function CustomerShipmentsPanel({ customerId }: { customerId: string }) {
  const { customer } = useCustomerDetail();

  const [pageSize, setPageSize] = React.useState(25);
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<CustomerShipments | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Bumped to force a refetch on Retry without duplicating the effect body.
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    shipmentsApi
      .byCustomer(
        customerId,
        { limit: pageSize, offset: (page - 1) * pageSize },
        { signal: ctrl.signal },
      )
      .then(setData)
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load the shipment history.');
      })
      .finally(() => {
        // An aborted request must not clear `loading` — StrictMode's
        // mount/abort/remount would otherwise paint an empty table as final.
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [customerId, page, pageSize, reloadKey]);

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // A page that no longer exists — walk back rather than showing an empty table.
  React.useEffect(() => {
    if (!loading && page > 1 && rows.length === 0 && total > 0) setPage(1);
  }, [loading, page, rows.length, total]);

  if (error) {
    return (
      <div className="rounded-lg border border-border bg-bg-elev">
        <EmptyState
          icon={PackageX}
          title="Couldn’t load the shipment history"
          hint={error}
          action={<Button onClick={() => setReloadKey((k) => k + 1)}>Retry</Button>}
        />
      </div>
    );
  }

  if (loading && data === null) {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-bg-elev p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (total === 0) {
    return <NeverShippedEmptyState customerName={customer?.name ?? 'this customer'} />;
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-border bg-bg-elev">
        <Table containerClassName="max-h-[65vh]">
          <TableHeader className="sticky top-0 z-10 bg-bg-elev">
            <TableRow>
              <TableHead>Shipped</TableHead>
              <TableHead>Item</TableHead>
              {/* No sign. The ledger stores these as negative deltas, but every
                  row here is a shipment, so a column of minus signs would be
                  noise rather than information. */}
              <TableHead className="text-right">Units</TableHead>
              <TableHead>Drawn from</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => (
              // performed_at is unique per shipment: the rows of one ship share
              // the transaction timestamp, and two ships cannot share it.
              <TableRow key={e.shipped_at} className="hover:bg-surface/60">
                <TableCell className="whitespace-nowrap text-xs text-text-2">
                  {formatWhen(e.shipped_at)}
                </TableCell>
                <TableCell className="max-w-[260px]">
                  {e.item_number ? (
                    <ItemLink itemId={e.item_id} itemNumber={e.item_number} />
                  ) : (
                    <span className="text-text-3" title="This item has since been deleted">
                      Deleted item
                    </span>
                  )}
                  {e.item_description && (
                    <div className="truncate text-xs text-text-3">{e.item_description}</div>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {e.total_qty.toLocaleString()}
                </TableCell>
                {/* The lots behind the number. One line each, so a shipment that
                    swept three lots shows all three rather than hiding two
                    behind a total nobody can reconcile. */}
                <TableCell className="max-w-[280px]">
                  <ul className="space-y-1">
                    {e.lines.map((ln) => (
                      <li key={ln.movement_id} className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-mono text-xs">
                          {ln.lot_number || ln.lot_id ? (
                            <LotLink lotId={ln.lot_id} lotNumber={ln.lot_number} />
                          ) : (
                            <span className="text-text-3">—</span>
                          )}
                        </span>
                        {e.lines.length > 1 && (
                          <span className="tabular-nums text-xs text-text-3">
                            ×{ln.qty.toLocaleString()}
                          </span>
                        )}
                        <span className="max-w-[180px] text-xs text-text-3">
                          <LocationPath path={ln.source_path} nodeId={ln.source_node_id} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </TableCell>
                <TableCell className="max-w-[180px] truncate font-mono text-xs text-text-2">
                  {e.reference_number || <span className="font-sans text-text-3">—</span>}
                </TableCell>
                <TableCell className="text-xs text-text-2">
                  {e.shipped_by ?? '—'}
                  {e.notes && (
                    <div className="max-w-[220px] truncate text-xs text-text-3" title={e.notes}>
                      {e.notes}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Gated on the SMALLEST page size, not the current one: gating on
          `total > pageSize` unmounts the pager the moment you pick a size that
          fits the whole history — taking the rows-per-page control with it, so a
          30-row history switched to "100 / page" could never be switched back. */}
      {total > PAGE_SIZES[0]! && (
        <NumberedPagination
          page={page}
          pageCount={pageCount}
          pageSize={pageSize}
          total={total}
          startIdx={(page - 1) * pageSize}
          rowsOnPage={rows.length}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          pageSizeOptions={PAGE_SIZES}
          noun="shipment"
        />
      )}
    </div>
  );
}
