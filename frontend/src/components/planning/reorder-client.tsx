'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, PackageCheck, Clock, HelpCircle, Truck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { AWAITING_RELEASE_META, STOCK_STATUS_META } from '@/config/inventory';
import { Card } from '@/components/ui/card';
import { NumberedPagination } from '@/components/ui/numbered-pagination';
import { EmptyState } from '@/components/shared/empty-state';
import { ItemLink } from '@/components/inventory/item-link';
import { TableSkeleton } from '@/components/shared/table-skeleton';
import { usePlanningShell } from '@/components/planning/planning-shell';
import { ApiError } from '@/lib/api/client';
import { planningApi, type ReorderGroup, type ReorderRow } from '@/lib/api/planning';
import { cn, daysFromNow, formatDate, formatNumber } from '@/lib/utils';

/** Column widths, shared by the header and every row so the two cannot drift. */
const COL = {
  status: 'w-40',
  stock: 'w-32',
  short: 'w-24',
  lead: 'w-40',
  po: 'w-36',
  supplier: 'w-40',
} as const;

/**
 * One stage of the reorder list (PLN-001), chosen by the route.
 *
 * The split matters more than it looks. An item below its threshold is at one
 * of three points on the same journey — nobody has ordered it, it is bought but
 * not here, or it is here but not shelved — and each calls for a different
 * person to do a different thing.
 *
 * Merged, they all read as "buy this". That is not hypothetical: when the
 * groups were one list, every row the client saw under it already had an open
 * purchase order or stock in the receiving bay covering it. Nothing is hidden
 * by the split — an item stays on screen until stock physically lands, per the
 * client's rule that a late order must not go quiet — only the heading changes.
 *
 * Each group is its own route and pages independently. Sharing one offset (the
 * first version) meant turning to page 2 of the tab you were reading also
 * turned the tab you were not, and the shorter group went blank once its rows
 * ran out.
 *
 * Read-only. Ordering lives on `/receiving`; releasing lives on the item page,
 * where the receive-to-inventory dialog and its signature already are.
 */
export function ReorderClient({ group }: { group: ReorderGroup }) {
  const { setTotals } = usePlanningShell();

  const [rows, setRows] = React.useState<ReorderRow[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [unplanned, setUnplanned] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(25);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // A page-size change returns to page 1 — otherwise you can be stranded on a
  // page that no longer exists.
  React.useEffect(() => setPage(1), [pageSize]);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoadError(null);
    planningApi
      .reorder({ group, limit: pageSize, offset: (page - 1) * pageSize }, { signal: ctrl.signal })
      .then((list) => {
        // A response for the tab we have since left would render the wrong
        // rows under the wrong heading; the server echoes the group back so
        // that is cheap to detect.
        if (list.group !== group) return;
        setRows(list.items);
        setTotal(list.total);
        setUnplanned(list.items_without_threshold);
        setTotals({
          order: list.order_total,
          onOrder: list.on_order_total,
          awaiting: list.awaiting_total,
        });
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load the reorder list.');
      });
    return () => ctrl.abort();
  }, [group, page, pageSize, setTotals]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const startIdx = (page - 1) * pageSize;

  // Deleting the last row of the final page would otherwise strand you on an
  // empty one.
  React.useEffect(() => {
    if (rows && total > 0 && page > pageCount) setPage(pageCount);
  }, [rows, total, page, pageCount]);

  return (
    <div className="space-y-3 px-6 py-5 sm:px-8">
      <Card className="min-w-0 overflow-hidden">
        {/* One horizontal scroller around header + rows together, so the two
            can never slide out of alignment on a narrow screen. */}
        <div className="overflow-x-auto">
          <div className="min-w-[1000px]">
            <ColumnHeader group={group} />

            {loadError ? (
              <EmptyState
                icon={AlertTriangle}
                title="Couldn't load the reorder list"
                hint={loadError}
              />
            ) : rows === null ? (
              <TableSkeleton rows={5} columns={5} label="Loading reorder list…" />
            ) : rows.length === 0 ? (
              <EmptyGroup group={group} unplanned={unplanned} />
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((r) => (
                  <ReorderRowLine key={r.item_id} row={r} group={group} />
                ))}
              </ul>
            )}
          </div>
        </div>

        {!loadError && total > 0 && (
          <div className="border-t border-border px-4 py-3">
            <NumberedPagination
              page={page}
              pageCount={pageCount}
              pageSize={pageSize}
              total={total}
              startIdx={startIdx}
              rowsOnPage={rows?.length ?? 0}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              noun="item"
            />
          </div>
        )}
      </Card>

      {/* An empty list is ambiguous on its own — it means either "nothing to
          order" or "nothing configured". Say which. */}
      {unplanned > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-text-3">
          <HelpCircle size={13} className="mt-px shrink-0" />
          <span>
            {unplanned} item{unplanned === 1 ? ' has' : 's have'} no reorder threshold set and can
            never appear here. Set one on the item to bring it into planning.
          </span>
        </p>
      )}

      <p className="text-xs text-text-3">
        Quantities are in the unit stock is counted in, not the pack it is bought by — an item
        ordered by the box still shows its threshold in units. Placing an order happens on{' '}
        <Link href="/receiving" className="text-accent hover:underline">
          Receiving
        </Link>
        ; an item stays on this list until the stock is on a shelf.
      </p>
    </div>
  );
}

/**
 * The lead column heading per group, or null to omit the column.
 *
 * The two tabs ask the same thing in different tenses, so they get different
 * headings. Nothing is ordered yet on "to order", so the only honest answer is
 * a duration — "how long will this take". Once an order exists, the useful
 * answer is a date: "is it late?" is a glance at a calendar, not arithmetic on
 * a lead time. On "to receive" the material has landed and the question is
 * already answered.
 */
function leadHeading(group: ReorderGroup): string | null {
  if (group === 'awaiting') return null;
  return group === 'on_order' ? 'Expected' : 'Lead time';
}

function ColumnHeader({ group }: { group: ReorderGroup }) {
  const lead = leadHeading(group);
  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface-2/50 px-4 py-2 text-[11px] uppercase tracking-wider text-text-3">
      {/* The leading column is whichever quantity defines the group. "To
          receive" is the project's name for that step everywhere — the
          requirement, the /receive-to-inventory endpoint and the dialog. */}
      <span className={cn(COL.status, 'shrink-0')}>
        {group === 'awaiting' ? 'To receive' : group === 'on_order' ? 'On order' : 'Status'}
      </span>
      <span className="min-w-0 flex-1">Item</span>
      <span className={cn(COL.stock, 'shrink-0 text-right')}>available / threshold</span>
      <span className={cn(COL.short, 'shrink-0 text-right')}>short</span>
      {lead && <span className={cn(COL.lead, 'shrink-0')}>{lead}</span>}
      {/* The order behind the date, on the one tab where an order exists. */}
      {group === 'on_order' && <span className={cn(COL.po, 'shrink-0')}>PO</span>}
      <span className={cn(COL.supplier, 'shrink-0 truncate')}>Supplier</span>
    </div>
  );
}

function EmptyGroup({ group, unplanned }: { group: ReorderGroup; unplanned: number }) {
  if (group === 'awaiting') {
    return (
      <EmptyState
        icon={PackageCheck}
        title="Nothing waiting to be received"
        hint="When a delivery arrives for an item that is below its threshold, it appears here instead of on the order list — so nobody buys what is already in the building. Receive it to inventory from the item's own page."
      />
    );
  }
  if (group === 'on_order') {
    return (
      <EmptyState
        icon={Truck}
        title="Nothing on order"
        hint="An item below its threshold moves here once a purchase order covers the shortfall, so it stops asking to be ordered again. It stays until the stock actually arrives."
      />
    );
  }
  return (
    <EmptyState
      icon={PackageCheck}
      title="Nothing needs ordering"
      hint={
        unplanned > 0
          ? 'Nothing is below a threshold that stock on site or on order does not already cover.'
          : 'An item appears here once its available stock reaches the reorder threshold set on the item.'
      }
    />
  );
}

/** One item row. `group` says which of the three questions it answers. */
function ReorderRowLine({ row, group }: { row: ReorderRow; group: ReorderGroup }) {
  const out = row.status_code === 'out_of_stock';
  const arrived = Number(row.qty_awaiting_release) || 0;
  const ordered = Number(row.qty_on_order) || 0;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-surface-2">
      <span className={cn(COL.status, 'shrink-0')}>
        {group === 'awaiting' ? (
          // A quantity, not a status — how much there is to receive to
          // inventory. Tone from the shared config so it matches the "Awaiting
          // release" badge the item pages show for the same material.
          <Badge tone={AWAITING_RELEASE_META.tone} className="gap-1">
            <PackageCheck size={11} />
            {formatNumber(arrived)}
          </Badge>
        ) : group === 'on_order' ? (
          // Neutral, not a warning: an open purchase order is the system
          // working. The point of this row is to say "already handled", so
          // colouring it like a problem would defeat the tab's whole purpose.
          <Badge tone="neutral" className="gap-1" title={`${ordered.toLocaleString()} units on open purchase orders`}>
            <Truck size={11} />
            {formatNumber(ordered)}
          </Badge>
        ) : (
          // The SAME component every inventory table uses. This row used to
          // build its own badge and pick its own tone, which is how "Out of
          // stock" came to be red here and grey in the tier list.
          <StatusBadge status={STOCK_STATUS_META[row.status_code].label} />
        )}
      </span>

      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <ItemLink itemId={row.item_id} itemNumber={row.item_number} />
        <span className="min-w-0 truncate text-text-2">{row.description}</span>
      </span>

      <span className={cn(COL.stock, 'shrink-0 text-right font-mono text-xs')}>
        <span className={out ? 'text-danger' : 'text-text'}>{fmt(row.qty_available)}</span>
        <span className="text-text-3"> / {fmt(row.reorder_threshold)}</span>
        {row.uom && <span className="ml-1 text-[10px] text-text-3">{row.uom}</span>}
      </span>

      <span className={cn(COL.short, 'shrink-0 text-right font-mono text-xs text-text-3')}>
        {Number(row.shortfall) > 0 ? fmt(row.shortfall) : '—'}
      </span>

      {/* Dropped on the receive tab: the material is already here, so how long
          it takes to arrive is a question that has been answered. */}
      {leadHeading(group) && (
        <span className={cn(COL.lead, 'shrink-0 truncate text-[11px]')}>
          {group === 'on_order' ? (
            <ExpectedArrival row={row} />
          ) : (
            /* Only the to-order tab needs the "already arrived" hint, since
               only there is someone deciding a quantity to buy. */
            <LeadTime row={row} arrived={arrived} />
          )}
        </span>
      )}

      {group === 'on_order' && (
        <span className={cn(COL.po, 'shrink-0 truncate text-[11px]')}>
          <NextOrderLink row={row} />
        </span>
      )}

      <span className={cn(COL.supplier, 'shrink-0 truncate text-[11px] text-text-3')}>
        {row.suppliers.length === 0 ? (
          <span className="italic">No supplier</span>
        ) : (
          <span title={row.suppliers.map((s) => s.supplier_name).join(', ')}>
            {row.suppliers.map((s) => s.supplier_name).join(', ')}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The purchase order this row is waiting on, linking to where it is received.
 *
 * `/receiving/{id}` opens that order's own panel, which already carries the
 * Receive action and its signature — so the shortest path from "this is late"
 * to "book the delivery" is one click, and this screen stays read-only.
 *
 * When more than one order is open the link is the soonest, matching the date
 * beside it; the count says there are others rather than pretending this is the
 * whole picture.
 */
function NextOrderLink({ row }: { row: ReorderRow }) {
  if (!row.next_order_id || !row.next_po_reference) {
    return <span className="text-text-3">—</span>;
  }
  const more = row.open_order_count - 1;
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <Link
        href={`/receiving/${row.next_order_id}`}
        title={
          more > 0
            ? `Open ${row.next_po_reference} to receive against it — ${more} other open order${more === 1 ? '' : 's'} for this item`
            : `Open ${row.next_po_reference} to receive against it`
        }
        className="truncate font-mono text-accent underline-offset-2 hover:underline"
      >
        {row.next_po_reference}
      </Link>
      {more > 0 && <span className="shrink-0 text-text-3">+{more}</span>}
    </span>
  );
}

/**
 * When the earliest open order should land.
 *
 * A date rather than a duration, because the question changes once an order
 * exists. "30d" answers "how long will this take" — useful when deciding to
 * buy, useless afterwards, since knowing whether the order is late means
 * mentally adding thirty days to a date the row does not show. "23 Sep" answers
 * it at a glance, and **an overdue order becomes visible**, which is the case
 * the client's "a late order must not go quiet" rule was actually about.
 *
 * The lead time it was derived from moves to the tooltip — still there when
 * someone wants to check the arithmetic, out of the way when they do not.
 *
 * Unknown stays unknown: no date is shown when the supplier on the open line
 * has no lead time recorded, rather than implying it lands today.
 */
function ExpectedArrival({ row }: { row: ReorderRow }) {
  if (!row.expected_arrival) {
    return (
      <span className="flex items-center gap-1 text-text-3" title="The supplier on this order has no lead time recorded, so there is no date to project.">
        <Clock size={11} /> unknown
      </span>
    );
  }
  const days = daysFromNow(row.expected_arrival);
  const overdue = days !== null && days < 0;
  const lead =
    row.lead_time_days === null ? 'lead time not recorded' : `${row.lead_time_days}-day lead time`;
  return (
    <span
      className={cn('flex min-w-0 items-center gap-1', overdue ? 'text-danger' : 'text-text-3')}
      title={
        overdue
          ? `Expected ${formatDate(row.expected_arrival)} — ${Math.abs(days)} days late. Based on the order date and a ${lead}.`
          : `Based on the order date and a ${lead}.`
      }
    >
      <Clock size={11} className="shrink-0" />
      <span className="truncate">
        {formatDate(row.expected_arrival)}
        {overdue && <span className="ml-1 font-medium">overdue</span>}
      </span>
    </span>
  );
}

/**
 * The item's worst-case lead time, plus any part-delivery already on site.
 *
 * Unknown is shown as unknown rather than as a dash or a zero: a missing lead
 * time is a supplier nobody has asked, and reading it as "no wait" is exactly
 * the mistake PLN-001 exists to prevent.
 *
 * The supplier is named beside the number ONLY when the item has more than one.
 * The figure is the longest of the item's suppliers, so with several it matters
 * which one it came from — "45d · Overseas Mfr" says the number is not the
 * 7-day local option. With a single supplier that attribution is the same word
 * the Supplier column is already showing on the same row.
 */
function LeadTime({ row, arrived }: { row: ReorderRow; arrived: number }) {
  const attributed = row.lead_time_supplier_name && row.suppliers.length > 1;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {row.lead_time_days === null ? (
        <span className="flex items-center gap-1 text-text-3">
          <Clock size={11} /> not set
        </span>
      ) : (
        <span
          className="flex min-w-0 items-center gap-1 text-text-3"
          // The tooltip always names it, including the single-supplier case —
          // there the row is unambiguous anyway, and it costs no width.
          title={
            row.lead_time_supplier_name
              ? `Longest lead time of this item's suppliers — ${row.lead_time_supplier_name}`
              : "Longest lead time of this item's suppliers"
          }
        >
          <Clock size={11} className="shrink-0" />
          <span className="truncate">
            {row.lead_time_days}d{attributed && ` · ${row.lead_time_supplier_name}`}
          </span>
        </span>
      )}
      {/* A part-delivery is the difference between ordering the whole gap and
          ordering the rest. */}
      {arrived > 0 && (
        <span
          className="shrink-0 text-accent"
          title={`${arrived.toLocaleString()} units have arrived but are not shelved — order only the difference.`}
        >
          +{formatNumber(arrived)} in
        </span>
      )}
    </span>
  );
}

/** NUMERIC arrives as a string; trim the stored decimal places for display. */
function fmt(n: string): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return n;
  return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
