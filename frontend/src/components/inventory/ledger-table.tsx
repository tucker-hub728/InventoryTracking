'use client';

import * as React from 'react';
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowUp,
  ArrowUpRight,
  CalendarClock,
  ChevronsUpDown,
  Undo2,
} from 'lucide-react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import { LotLink } from '@/components/inventory/lot-link';
import { LocationLink } from '@/components/locations/location-link';
import type { ApiItemKitConsumption } from '@/lib/api/kits';
import type { LedgerEntry } from '@/types/inventory';
import type { BadgeTone } from '@/types/ui';
import { expiryStatus } from '@/lib/inventory-helpers';
import { cn, daysFromNow } from '@/lib/utils';

interface LotGroup {
  lot: string;
  /** Lot UUID for the group. Rows are grouped by lot number within a single
   *  item, and lot numbers are unique per item, so every row shares one id. */
  lotId: string | null;
  rows: LedgerEntry[];
  totalIn: number;
  totalOut: number;
  balance: number;
  /**
   * Representative expiry for the lot — the *soonest* usable expiration date
   * among the group's rows (lots normally share one date, but we take the
   * earliest to be conservative). ``null`` when no row has a usable date.
   */
  exp: string | null;
  /** ``daysFromNow(exp)`` for the representative date; ``null`` if no date. */
  expDays: number | null;
}

/** Tri-state expiry sort: off → soonest-first → latest-first → off. */
type SortDir = 'asc' | 'desc' | null;
/**
 * Movement type → the Transaction chip.
 *
 * Shown for every tier. It started as an AY/FG-only column (Made / Kitted /
 * Returned all touch the same lot, so only the type distinguishes them), but a
 * raw material's ledger reads better with it too — and it replaces the
 * "Transfer" badge that used to be crammed into the Location column.
 */
const TXN_LABEL: Record<string, { label: string; tone: BadgeTone }> = {
  production_output: { label: 'Made', tone: 'success' },
  kit_issue: { label: 'Kitted', tone: 'danger' },
  kit_additional_issue: { label: 'Kitted +', tone: 'danger' },
  // Three distinct return events — physically identical, different meaning.
  backflush: { label: 'Back-flushed', tone: 'accent' },
  kit_return: { label: 'Returned', tone: 'accent' },
  kit_cancel_return: { label: 'Cancel return', tone: 'warning' },
  receipt: { label: 'Received', tone: 'success' },
  dispense: { label: 'Used', tone: 'danger' },
  discard: { label: 'Discarded', tone: 'danger' },
  adjustment: { label: 'Adjusted', tone: 'warning' },
  transfer_in: { label: 'Transfer in', tone: 'neutral' },
  transfer_out: { label: 'Transfer out', tone: 'neutral' },
  // Terminal customer shipment (CUST-001) — the finished good leaves inventory.
  customer_shipment: { label: 'Shipped', tone: 'danger' },
};

function TransactionCell({ entry }: { entry: LedgerEntry }) {
  const meta = entry.movementType ? TXN_LABEL[entry.movementType] : undefined;
  if (!meta) return <span className="text-xs text-text-3">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={meta.tone}>{meta.label}</Badge>
      {entry.kitNumber && (
        <span className="font-mono text-[11px] text-text-3">{entry.kitNumber}</span>
      )}
      {/* Reference / tracking number on a shipment (TRX-005). */}
      {entry.referenceNumber && (
        <span
          className="font-mono text-[11px] text-text-3"
          title={`Reference: ${entry.referenceNumber}`}
        >
          {entry.referenceNumber}
        </span>
      )}
    </span>
  );
}

/** Expiry-status filter; ``all`` disables it. */
type StatusFilter = 'all' | 'expired' | 'near' | 'ok';

const STATUS_LABEL: Record<Exclude<StatusFilter, 'all'>, string> = {
  expired: 'Expired',
  near: 'Near expiry',
  ok: 'OK',
};

/**
 * Group ledger rows by lot, preserving first-appearance order. Each group
 * carries its own Units-In / Units-Out / Balance subtotal — mirroring the
 * demo workbook's per-item ledger sheet (a "Total" row per lot, then an
 * item grand total at the bottom).
 */
function groupByLot(entries: LedgerEntry[]): LotGroup[] {
  const order: string[] = [];
  const byLot = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const lot = e.lot || '—';
    let bucket = byLot.get(lot);
    if (!bucket) {
      bucket = [];
      byLot.set(lot, bucket);
      order.push(lot);
    }
    bucket.push(e);
  }
  return order.map((lot) => {
    const rows = byLot.get(lot)!;
    const totalIn = rows.reduce((s, e) => s + e.in, 0);
    const totalOut = rows.reduce((s, e) => s + e.out, 0);
    // Soonest usable expiry across the lot's rows drives its expiry risk.
    let exp: string | null = null;
    let expDays: number | null = null;
    for (const e of rows) {
      const d = daysFromNow(e.exp);
      if (d === null) continue;
      if (expDays === null || d < expDays) {
        expDays = d;
        exp = e.exp;
      }
    }
    return {
      lot,
      lotId: rows.find((e) => e.lotId)?.lotId ?? null,
      rows,
      totalIn,
      totalOut,
      balance: totalIn - totalOut,
      exp,
      expDays,
    };
  });
}

/**
 * Filter lot groups by expiry status and/or an "expiring within N days"
 * horizon. Lots with **no usable expiry date are always kept** (they can't be
 * judged against an expiry filter, so we don't hide them). The horizon matches
 * only *upcoming* lots (``0 <= days <= within``) — already-expired lots are
 * excluded, since "expiring" means about to expire, not already past. Use the
 * status filter set to "Expired" to see those.
 */
function filterGroups(
  groups: LotGroup[],
  status: StatusFilter,
  within: number | null,
  thresholdDays: number,
): LotGroup[] {
  if (status === 'all' && within === null) return groups;
  return groups.filter((g) => {
    if (g.expDays === null) return true; // always visible — no date to filter on
    if (status !== 'all') {
      const s = expiryStatus(g.exp, thresholdDays);
      if (!s || s.label !== STATUS_LABEL[status]) return false;
    }
    if (within !== null && (g.expDays < 0 || g.expDays > within)) return false;
    return true;
  });
}

/**
 * Sort lot groups by representative expiry. Lots without a usable date stay
 * pinned to their original slots; dated lots sort amongst themselves and fill
 * the remaining slots in order, so undated lots never jump position.
 */
function sortGroups(groups: LotGroup[], dir: SortDir): LotGroup[] {
  if (dir === null) return groups;
  const dated: LotGroup[] = [];
  const datedSlots: number[] = [];
  groups.forEach((g, i) => {
    if (g.expDays !== null) {
      dated.push(g);
      datedSlots.push(i);
    }
  });
  dated.sort((a, b) =>
    dir === 'asc' ? a.expDays! - b.expDays! : b.expDays! - a.expDays!,
  );
  const result = groups.slice();
  datedSlots.forEach((slot, k) => {
    result[slot] = dated[k]!;
  });
  return result;
}

/** Parse the "within N days" input into a non-negative number, or null. */
function parseWithin(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Owns the expiry sort + filter state and derives the visible, ordered lot
 * groups. Lives in a hook so the toolbar can render *outside* the table's
 * horizontal-scroll container while the table consumes the same result.
 */
export function useLedgerExpiryControls(
  entries: LedgerEntry[],
  nearExpiryThresholdDays: number,
) {
  const [sortDir, setSortDir] = React.useState<SortDir>(null);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all');
  const [withinInput, setWithinInput] = React.useState('');

  const allGroups = React.useMemo(() => groupByLot(entries), [entries]);
  const within = parseWithin(withinInput);
  const groups = React.useMemo(
    () =>
      sortGroups(
        filterGroups(allGroups, statusFilter, within, nearExpiryThresholdDays),
        sortDir,
      ),
    [allGroups, statusFilter, within, nearExpiryThresholdDays, sortDir],
  );

  const filtersActive = statusFilter !== 'all' || withinInput.trim() !== '';
  const cycleSort = React.useCallback(
    () => setSortDir((d) => (d === null ? 'asc' : d === 'asc' ? 'desc' : null)),
    [],
  );
  const resetFilters = React.useCallback(() => {
    setStatusFilter('all');
    setWithinInput('');
  }, []);

  return {
    groups,
    totalLots: allGroups.length,
    visibleLots: groups.length,
    sortDir,
    cycleSort,
    statusFilter,
    setStatusFilter,
    withinInput,
    setWithinInput,
    filtersActive,
    resetFilters,
  };
}

export type LedgerExpiryControls = ReturnType<typeof useLedgerExpiryControls>;

/**
 * The expiry filter toolbar — rendered above (outside) the ledger table, so it
 * isn't tied to the table's horizontal scroll. Mirrors the inventory list
 * filter bar: self-describing controls, no leading captions.
 */
export function LedgerExpiryToolbar({
  statusFilter,
  setStatusFilter,
  withinInput,
  setWithinInput,
  filtersActive,
  resetFilters,
  visibleLots,
  totalLots,
}: Pick<
  LedgerExpiryControls,
  | 'statusFilter'
  | 'setStatusFilter'
  | 'withinInput'
  | 'setWithinInput'
  | 'filtersActive'
  | 'resetFilters'
  | 'visibleLots'
  | 'totalLots'
>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
        <SelectTrigger
          className="w-[170px] [&>span]:min-w-0 [&>span]:truncate"
          aria-label="Filter by expiry status"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All expiry statuses</SelectItem>
          <SelectItem value="expired">Expired</SelectItem>
          <SelectItem value="near">Near expiry</SelectItem>
          <SelectItem value="ok">OK</SelectItem>
        </SelectContent>
      </Select>

      <Input
        type="number"
        min={0}
        inputMode="numeric"
        icon={CalendarClock}
        value={withinInput}
        onChange={(e) => setWithinInput(e.target.value)}
        placeholder="Expiring within…"
        trailing={<span className="shrink-0 text-xs text-text-3">days</span>}
        aria-label="Expiring within N days"
        wrapperClassName="w-[200px]"
      />

      {filtersActive && (
        <Button variant="ghost" size="sm" onClick={resetFilters}>
          Clear
        </Button>
      )}
      <span className="ml-auto text-xs text-text-3" role="status">
        {visibleLots} of {totalLots} lots
      </span>
    </div>
  );
}

interface Props {
  /** Visible, ordered lot groups from {@link useLedgerExpiryControls}. */
  groups: LotGroup[];
  /**
   * Near-expiry window (days) for the colour-coded Expiry badges: lots
   * within this many days read "Near expiry" (amber), past lots
   * "Expired" (red), the rest "OK" (green).
   */
  nearExpiryThresholdDays: number;
  /** Current expiry sort direction (drives the header arrow). */
  sortDir: SortDir;
  /** Cycle the expiry sort: off → asc → desc → off. */
  onCycleSort: () => void;
  /** Whether a filter is active — switches the grand-total label + empty copy. */
  filtersActive: boolean;
  /**
   * Invoked when the operator clicks the per-row Reverse action. When
   * omitted, the action column is hidden — used by read-only viewers
   * who lack the ``inventory:sign`` permission.
   */
  onReverseRequest?: (entry: LedgerEntry) => void;
  /** Show the Customer column. Only built items (finished goods / sub-assemblies)
   *  can ship to a customer, so raw materials omit it (it would always be —). */
  showCustomer?: boolean;
  /**
   * Per-kit reconciliation for this item — issued / used / returned.
   *
   * Using material writes NO stock movement (it already left ``v_item_stock``
   * at issue, kitting.md §4.3), so the ledger alone can show ``Kitted`` and
   * ``Back-flushed`` but never the *used* figure between them. These rows
   * supply it, rendered as a non-balance sub-line so the ledger reads the way
   * REQ-2026-07-09-TRX-003 describes: "issued fifteen, used twelve,
   * backflushed three" (client 2026-07-28).
   */
  kitUsage?: ApiItemKitConsumption[];
}

/** The reconciliation sentence for one kit, phrased for its status. ``remainder``
 *  means different things per status, so each reads differently:
 *   - closed    → the remainder was back-flushed at close-out
 *   - open      → the remainder is still on the production floor, and ``used``
 *                 is live (cumulative across Produce batches, KIT-007)
 *   - cancelled → nothing stays on the floor; everything not used came back
 *
 * Early returns are deliberately NOT called out on closed and open kits (client
 * 2026-07-30): issued / used / back-flushed is the reconciliation
 * REQ-2026-07-09-TRX-003 asks for, and a fourth figure made the line harder to
 * read without changing the arithmetic — an early return is already visible as
 * its own ``Returned`` row in the ledger above. It stays in the cancelled
 * phrasing, where it IS the whole story. */
function kitUsageSentence(u: ApiItemKitConsumption): string {
  const parts = [`issued ${u.issued_total}`, `used ${u.used_qty}`];
  if (u.status === 'closed') {
    parts.push(`back-flushed ${u.remainder}`);
  } else if (u.status === 'cancelled') {
    parts.push(`returned ${u.early_returned_qty + u.remainder} on cancel`);
  } else {
    parts.push(`${u.remainder} still on floor`);
  }
  return parts.join(' · ');
}

export function LedgerTable({
  groups,
  nearExpiryThresholdDays,
  sortDir,
  onCycleSort,
  filtersActive,
  onReverseRequest,
  showCustomer = false,
  kitUsage,
}: Props) {
  const showActions = Boolean(onReverseRequest);

  // ``used_qty`` belongs to the kit LINE, not to any single issue row — a kit
  // can issue twice, and can draw from several lots — so the sentence is
  // rendered ONCE per kit, after that kit's last visible row anywhere in the
  // table. Keyed "lot|rowIndex" so the row loop can look itself up.
  const usageByKit = React.useMemo(
    () => new Map((kitUsage ?? []).map((u) => [u.kit_id, u])),
    [kitUsage],
  );
  const usageAnchor = React.useMemo(() => {
    const anchor = new Map<string, ApiItemKitConsumption>();
    if (usageByKit.size === 0) return anchor;
    const lastSeen = new Map<string, string>();
    groups.forEach((g) =>
      g.rows.forEach((e, i) => {
        if (e.kitId && usageByKit.has(e.kitId)) lastSeen.set(e.kitId, `${g.lot}|${i}`);
      }),
    );
    lastSeen.forEach((key, kitId) => anchor.set(key, usageByKit.get(kitId)!));
    return anchor;
  }, [groups, usageByKit]);

  if (groups.length === 0) {
    return (
      <EmptyState
        title="No lots match"
        hint="Adjust the expiry filters to see more lots."
      />
    );
  }

  const grandIn = groups.reduce((s, g) => s + g.totalIn, 0);
  const grandOut = groups.reduce((s, g) => s + g.totalOut, 0);
  const grandBalance = grandIn - grandOut;
  // Date, Transaction, In, Out, Balance, Location, [Customer], Lot, Expiry, By (+ actions)
  const cols = 9 + (showCustomer ? 1 : 0) + (showActions ? 1 : 0);

  const SortIcon = sortDir === 'asc' ? ArrowUp : sortDir === 'desc' ? ArrowDown : ChevronsUpDown;
  const sortAria = sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : 'none';

  return (
    // The height belongs HERE, on the table's own scroll container — that is
    // what the sticky column headers and the sticky totals row anchor to.
    //
    // Sized against what is LEFT of the window rather than a flat ``70vh``:
    // the pane starts about 330px down (topbar, page header, tab bar, expiry
    // toolbar), so 70vh ran past the bottom of the window and the pinned totals
    // row — the whole point of pinning it — was half under the fold. The floor
    // keeps it usable if the window is short enough for the subtraction to win.
    <Table containerClassName="max-h-[calc(100vh-330px)] min-h-[240px]">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[120px]">Date</TableHead>
          <TableHead className="w-[150px]">Transaction</TableHead>
          <TableHead className="w-[90px] text-right">Units In</TableHead>
          <TableHead className="w-[90px] text-right">Units Out</TableHead>
          <TableHead className="w-[100px] text-right">Balance</TableHead>
          <TableHead className="w-[160px]">Location</TableHead>
          {showCustomer && <TableHead className="w-[150px]">Customer</TableHead>}
          <TableHead className="w-[140px]">Lot</TableHead>
          <TableHead className="w-[150px]" aria-sort={sortAria}>
            <button
              type="button"
              onClick={onCycleSort}
              className="inline-flex items-center gap-1 text-inherit transition-colors hover:text-text"
              title="Sort lots by expiry date"
            >
              Expiry
              <SortIcon
                size={11}
                className={cn(sortDir === null && 'opacity-60')}
                aria-hidden
              />
            </button>
          </TableHead>
          <TableHead className="w-[160px]">By</TableHead>
          {showActions && <TableHead className="w-[80px]" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <React.Fragment key={group.lot}>
            {group.rows.map((e, i) => {
              const canReverse =
                showActions &&
                Boolean(e.movementId) &&
                !e.isReversal &&
                !e.isReversed;
              const reverseHint = e.isReversal
                ? 'Cannot reverse a reversal'
                : e.isReversed
                  ? 'Already reversed'
                  : undefined;
              const expiry = expiryStatus(e.exp, nearExpiryThresholdDays);
              const isTransfer =
                e.movementType === 'transfer_out' || e.movementType === 'transfer_in';
              // Rendered under this row when it is the kit's LAST row in the
              // table (see usageAnchor) — one sentence per kit, not per row.
              const usage = usageAnchor.get(`${group.lot}|${i}`);
              return (
                <React.Fragment key={e.movementId ?? `${group.lot}-${e.date}-${i}`}>
                <TableRow
                  className={cn(
                    'group',
                    isTransfer && 'bg-accent-soft/60',
                    e.isReversal && 'bg-bg-elev/60',
                    e.isReversed && 'opacity-70',
                  )}
                >
                  <TableCell className="font-mono text-xs">{e.date}</TableCell>
                  <TableCell>
                    <TransactionCell entry={e} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {e.in > 0 ? (
                      <span className="inline-flex items-center gap-1 text-success">
                        <ArrowDownLeft size={11} aria-hidden /> {e.in}
                      </span>
                    ) : (
                      <span className="text-text-3">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {e.out > 0 ? (
                      <span className="inline-flex items-center gap-1 text-danger">
                        <ArrowUpRight size={11} aria-hidden /> {e.out}
                      </span>
                    ) : (
                      <span className="text-text-3">—</span>
                    )}
                  </TableCell>
                  {/* Per-row balance lives on the lot Total row, like the workbook. */}
                  <TableCell className="text-right font-mono text-xs text-text-3">—</TableCell>
                  {/* The storage location the movement touched. For a shipment
                      that's the source the finished good left from. */}
                  <TableCell className="text-xs text-text-2">
                    <LocationLink
                      nodeId={e.locationId}
                      name={e.location}
                      path={e.locationPath}
                      // On a kit row the location is a production floor, whose
                      // page is three tabs of kits. Pass the kit's state so the
                      // link opens the tab holding THIS kit — without it a
                      // closed kit landed on "In production".
                      kitStatus={e.kitId ? usageByKit.get(e.kitId)?.status : undefined}
                      className="block truncate"
                    />
                  </TableCell>
                  {/* Customer — the named recipient a shipment left inventory to
                      (CUST-001). Shown only for built items (raw materials never
                      ship). Only shipments populate it; other rows are —. */}
                  {showCustomer && (
                    <TableCell className="text-xs text-text-2">
                      {e.movementType === 'customer_shipment' ? (
                        <span
                          className="block truncate"
                          title={e.referenceNumber ? `Ref ${e.referenceNumber}` : undefined}
                        >
                          {e.customerName ?? (
                            <span className="italic text-text-3">Catalog (no customer)</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-text-3">—</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="font-mono text-xs text-text-2">
                    <LotLink lotId={e.lotId} lotNumber={e.lot} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {expiry ? (
                      <Badge tone={expiry.tone} dot className="font-mono" title={expiry.label}>
                        {e.exp}
                      </Badge>
                    ) : (
                      <span className="font-mono text-text-2">{e.exp}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-text-2">
                    {e.actorName ? (
                      <span className="block truncate" title={e.actorName}>
                        {e.actorName}
                      </span>
                    ) : (
                      <span className="text-text-3">—</span>
                    )}
                  </TableCell>
                  {showActions && (
                    <TableCell className="text-right">
                      {canReverse ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="row-action h-7 px-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => onReverseRequest?.(e)}
                          title="Reverse this movement"
                        >
                          <Undo2 size={12} aria-hidden /> Reverse
                        </Button>
                      ) : (
                        <span className="text-[10px] text-text-3" title={reverseHint} />
                      )}
                    </TableCell>
                  )}
                </TableRow>

                {/* Kit reconciliation — NOT a stock movement. The material left
                    the balance at Kitted time (TRX-001 / kitting.md §4.3); this
                    only spells out how much of it was actually used, which the
                    ledger otherwise can't say (REQ-2026-07-09-TRX-003). Deliberately
                    contributes nothing to Units in/out, Balance or the totals. */}
                {usage && (
                  <TableRow className="border-none bg-surface/50 hover:bg-surface/50">
                    <TableCell />
                    <TableCell
                      colSpan={9 + (showCustomer ? 1 : 0) + (showActions ? 1 : 0)}
                      className="py-1.5 text-[11px] text-text-3"
                    >
                      <span
                        className="inline-flex flex-wrap items-center gap-1.5"
                        title="Consumption is not a stock movement — the material left inventory when it was kitted. This line only reconciles how much of it was used."
                      >
                        <span aria-hidden className="text-text-3">
                          └
                        </span>
                        <span className="font-mono text-text-2">{usage.kit_number}</span>
                        <span>· {kitUsageSentence(usage)}</span>
                        {(usage.status === 'issued' || usage.status === 'in_production') && (
                          <Badge tone="warning">in production</Badge>
                        )}
                        {usage.status === 'cancelled' && <Badge tone="danger">cancelled</Badge>}
                      </span>
                    </TableCell>
                  </TableRow>
                )}
                </React.Fragment>
              );
            })}

            {/* Per-lot subtotal — highlighted like the workbook's yellow lot totals */}
            <TableRow className="border-t border-warning/30 bg-warning-soft font-semibold">
              <TableCell className="text-[11px] uppercase tracking-wide text-warning">
                Total
              </TableCell>
              <TableCell />
              <TableCell className="text-right font-mono text-xs text-success">
                {group.totalIn}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-danger">
                {group.totalOut}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">{group.balance}</TableCell>
              <TableCell />
              {showCustomer && <TableCell />}
              <TableCell className="font-mono text-xs text-text-2">
                <LotLink lotId={group.lotId} lotNumber={group.lot} />
              </TableCell>
              <TableCell />
              <TableCell />
              {showActions && <TableCell />}
            </TableRow>
          </React.Fragment>
        ))}

        {/* Item grand total — over the currently visible lots.
            Pinned to the foot of the scroll pane: on an item with many lots the
            totals are the reason you opened the ledger, and they used to sit
            past the end of a list you had to scroll to reach. ``sticky`` goes
            on the CELLS, not the row — a sticky <tr> is not honoured
            everywhere. The background must stay opaque or the rows sliding
            underneath show through it. */}
        <TableRow className="border-t-2 border-accent/40 font-bold">
          <TableCell className="sticky bottom-0 z-10 bg-accent-soft text-[11px] uppercase tracking-wide">
            {filtersActive ? 'Filtered total' : 'Item total'}
          </TableCell>
          {/* Transaction spacer — without it the totals shift a column left. */}
          <TableCell className="sticky bottom-0 z-10 bg-accent-soft" />
          <TableCell className="sticky bottom-0 z-10 bg-accent-soft text-right font-mono text-sm text-success">
            {grandIn}
          </TableCell>
          <TableCell className="sticky bottom-0 z-10 bg-accent-soft text-right font-mono text-sm text-danger">
            {grandOut}
          </TableCell>
          <TableCell className="sticky bottom-0 z-10 bg-accent-soft text-right font-mono text-sm">
            {grandBalance}
          </TableCell>
          {/* label + spacer + the three totals = 5 cells already rendered. */}
          <TableCell className="sticky bottom-0 z-10 bg-accent-soft" colSpan={cols - 5} />
        </TableRow>
      </TableBody>
    </Table>
  );
}
