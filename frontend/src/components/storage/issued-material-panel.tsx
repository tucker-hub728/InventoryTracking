'use client';

/**
 * What has been issued to a scrap location — its disposition log
 * (REQ-2026-08-04-TRX-001/002).
 *
 * The one thing this component must never do is read like stock. Every row is
 * material that LEFT controlled inventory at the moment it was recorded; the
 * location holds none of it. So there is no "on hand" figure, no drill-down into
 * a holding, nothing to transfer out of, and the header says so in words rather
 * than trusting the column names to carry it.
 *
 * That is also why this is a separate panel rather than another
 * ``StorageLeafGrid``: the grid's whole vocabulary is units, occupancy and
 * capacity, and every one of those would be a lie here.
 *
 * The sub-type tabs beside this one are the opposite case and stay exactly as
 * they were — a scrap location can still RECEIVE transfers into its shelves and
 * freezers, and that stock IS tracked. Two facts about one place, kept apart.
 */

import * as React from 'react';
import { MinusCircle } from 'lucide-react';

import { ItemLink } from '@/components/inventory/item-link';
import { LotLink } from '@/components/inventory/lot-link';
import { EmptyState } from '@/components/shared/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { NumberedPagination } from '@/components/ui/numbered-pagination';
import { ApiError } from '@/lib/api/client';
import { issuesApi, type IssuedList } from '@/lib/api/issues';
import { Button } from '@/components/ui/button';

const PAGE_SIZES = [10, 25, 50, 100];

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function IssuedMaterialPanel({
  nodeId,
  locationName,
}: {
  nodeId: string;
  locationName: string;
}) {
  const [pageSize, setPageSize] = React.useState(25);
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<IssuedList | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Bumped to force a refetch on Retry without duplicating the effect body.
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    issuesApi
      .issuedAt(nodeId, {
        limit: pageSize,
        offset: (page - 1) * pageSize,
        signal: ctrl.signal,
      })
      .then((res) => setData(res))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load the issue history.');
      })
      .finally(() => {
        // An aborted request must not clear `loading` — StrictMode's
        // mount/abort/remount would otherwise paint an empty table as final.
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [nodeId, page, pageSize, reloadKey]);

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // A page that no longer exists — the last row on page 3 was the only one, and
  // something removed it. Walk back rather than showing an empty table.
  React.useEffect(() => {
    if (!loading && page > 1 && rows.length === 0 && total > 0) setPage(1);
  }, [loading, page, rows.length, total]);

  if (error) {
    return (
      <div className="rounded-lg border border-border bg-bg-elev">
        <EmptyState
          title="Couldn’t load the issue history"
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
    return (
      <div className="rounded-lg border border-border bg-bg-elev">
        <EmptyState
          icon={MinusCircle}
          title={`Nothing issued to ${locationName} yet`}
          hint={
            'Material issued here is removed from inventory permanently. Issue it from an ' +
            'item’s page — open the item and choose Issue.'
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Says what the table is before the first column name can be misread.
          "12 issues · 340 units" next to a location would otherwise look like a
          holding, which is the single most damaging way to read this page. */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2">
        <p className="text-xs text-warning">
          <span className="font-medium">
            {data?.total_qty.toLocaleString()} unit
            {data?.total_qty === 1 ? '' : 's'}
          </span>{' '}
          issued to {locationName} across {total} transaction{total === 1 ? '' : 's'} — all
          removed from inventory. This is a record of what left, not stock held here.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-bg-elev">
        <Table containerClassName="max-h-[65vh]">
          <TableHeader className="sticky top-0 z-10 bg-bg-elev">
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Lot</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead>Issued from</TableHead>
              <TableHead>By</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Comment</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.movement_id}>
                <TableCell className="max-w-[240px]">
                  <ItemLink itemId={r.item_id} itemNumber={r.item_number} />
                  {r.item_description && (
                    <div className="truncate text-xs text-text-3">{r.item_description}</div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {r.lot_number ? (
                    <LotLink lotId={r.lot_id} lotNumber={r.lot_number} />
                  ) : (
                    <span className="text-text-3">—</span>
                  )}
                </TableCell>
                {/* No sign. The ledger stores this as a negative delta, but here
                    every row is an issue, so a column of minus signs would be
                    noise rather than information. */}
                <TableCell className="text-right tabular-nums">
                  {r.qty.toLocaleString()}
                </TableCell>
                <TableCell className="max-w-[260px] truncate text-xs text-text-2">
                  {r.source_path ?? '—'}
                </TableCell>
                <TableCell className="text-xs text-text-2">{r.issued_by ?? '—'}</TableCell>
                <TableCell className="whitespace-nowrap text-xs text-text-2">
                  {formatWhen(r.issued_at)}
                </TableCell>
                <TableCell className="max-w-[280px] truncate text-xs text-text-3">
                  {r.notes || '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Gated on the SMALLEST page size, not the current one. Gating on
          `total > pageSize` unmounts the pager the moment you pick a size that
          fits the whole log — taking the rows-per-page control with it, so a
          30-row log switched to "100 / page" can never be switched back. */}
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
          noun="issue"
        />
      )}
    </div>
  );
}
