'use client';

import * as React from 'react';
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Search,
  Trash2,
  Truck,
  X,
  XCircle,
  PackageCheck,
} from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
// Still used by the rows-per-page control at the foot of the table.
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { ItemLink } from '@/components/inventory/item-link';
import { usePermission } from '@/hooks/use-permission';
import type { ReauthResponse } from '@/lib/api/auth';
import { cn } from '@/lib/utils';
import type { BadgeTone } from '@/types/ui';
import { ApiError } from '@/lib/api/client';
import {
  receivingApi,
  ORDER_STATUS_LABEL,
  type Order,
  type OrderStatus,
} from '@/lib/api/receiving';

import { ArchivePanel } from './archive-panel';
import { ReceiptTransactionsTable } from './receipt-transactions-table';
import { ReceiptIntakeDialog } from './receipt-intake-dialog';
import { ReceiveDialog } from './receive-dialog';
import { OrderEditDialog } from './lot-edit-dialog';
import { LotDetailEditDialog } from './lot-detail-edit-dialog';

const ALL_STATUSES: readonly OrderStatus[] = [
  'open',
  'partially_received',
  'received',
  'cancelled',
];

/**
 * What the list opens on (DATA-003): the orders that still need something from
 * someone. Ticked boxes rather than a fixed "needs attention" option, so the
 * operator can widen it without losing the sensible starting point — and can
 * see WHICH statuses that starting point means.
 *
 * "Archived" is deliberately NOT one of these. It is a different axis (an
 * archived order still has a status), and mixing it in would let you ask for
 * "archived + open", which DATA-002 guarantees is always empty. The archive
 * has its own panel.
 */
const DEFAULT_STATUSES: readonly OrderStatus[] = ['open', 'partially_received'];
const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;

// Search, filtering and paging all happen SERVER-side. They used to run in the
// browser over the 200 most-recent orders, which meant a search could only ever
// find what that slice happened to contain — "no results" and "no results in
// the newest 200" looked identical, and the 201st order was unreachable however
// hard you looked. With the archiving policy in play (DATA-001) the list is
// also expected to grow well past any such cap.
const SEARCH_DEBOUNCE_MS = 250;

const LIST_PATH = '/receiving';
const orderPath = (id: string) => `${LIST_PATH}/${id}`;
const orderIdFromPath = (pathname: string) =>
  /^\/receiving\/([^/]+)\/?$/.exec(pathname)?.[1] ?? null;

const STATUS_TONE: Record<OrderStatus, BadgeTone> = {
  open: 'accent',
  partially_received: 'warning',
  received: 'success',
  cancelled: 'neutral',
};

export function ReceivingPageClient({
  /** Order id from the `/receiving/[id]` segment, on a cold load or refresh. */
  initialOrderId,
}: {
  initialOrderId?: string;
} = {}) {
  const canCreate = usePermission('inventory', 'create');
  const canReceive = usePermission('inventory', 'sign');

  const [orders, setOrders] = React.useState<Order[]>([]);
  // Server-reported count for the CURRENT filter + search, which is what the
  // pager has to page over — not the length of the rows in hand.
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // DATA-003: open on what needs action, not on every order ever completed.
  const [statuses, setStatuses] = React.useState<OrderStatus[]>([
    ...DEFAULT_STATUSES,
  ]);

  const [query, setQuery] = React.useState('');
  // Debounced copy — the query the server is actually asked for, so a keystroke
  // doesn't become a request.
  const [searchTerm, setSearchTerm] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState<number>(PAGE_SIZE_OPTIONS[0]);

  React.useEffect(() => {
    const id = setTimeout(() => setSearchTerm(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // Any change to what is being asked for restarts at page 1 — page 4 of a
  // different question is not a meaningful place to be.
  React.useEffect(() => {
    setPage(1);
  }, [statuses, searchTerm, pageSize]);

  // What the trigger reads. Naming one or two statuses beats "2 selected" —
  // the operator can see what they are looking at without opening the menu.
  const statusSummary = React.useMemo(() => {
    if (statuses.length === 0) return 'No status selected';
    if (statuses.length === ALL_STATUSES.length) return 'All statuses';
    if (statuses.length <= 2) {
      return statuses.map((s) => ORDER_STATUS_LABEL[s]).join(', ');
    }
    return `${statuses.length} statuses`;
  }, [statuses]);

  const [intakeOpen, setIntakeOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  // The order sheet was reached from the archive panel, so it owes a way back.
  const [cameFromArchive, setCameFromArchive] = React.useState(false);
  const [receiveTarget, setReceiveTarget] = React.useState<Order | null>(null);
  const [detail, setDetail] = React.useState<Order | null>(null);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const resp = await receivingApi.listOrders({
          q: searchTerm || undefined,
          // Every box ticked is the same question as none of them, so send
          // nothing and let the server skip the filter entirely.
          status:
            statuses.length === 0 || statuses.length === ALL_STATUSES.length
              ? undefined
              : statuses,
          limit: pageSize,
          offset: (page - 1) * pageSize,
          signal,
        });
        setOrders(resp.items);
        setTotal(resp.total);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load orders.');
      } finally {
        setLoading(false);
      }
    },
    [statuses, searchTerm, page, pageSize],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const upsert = React.useCallback(
    (order: Order) =>
      setOrders((prev) => {
        const i = prev.findIndex((o) => o.id === order.id);
        if (i === -1) return [order, ...prev];
        const next = [...prev];
        next[i] = order;
        return next;
      }),
    [],
  );

  const removeOrder = React.useCallback(
    (id: string) => setOrders((prev) => prev.filter((o) => o.id !== id)),
    [],
  );

  // ── Sheet ⇄ URL ────────────────────────────────────────────────────────
  // The open sheet is reflected at /receiving/<id> so it survives a refresh
  // and can be linked to. This uses the native History API rather than
  // router.push: /receiving and /receiving/[id] are separate route segments,
  // so a Next navigation would swap the page component out, remounting this
  // client and re-fetching the whole list behind the sheet on every open.
  const ordersRef = React.useRef(orders);
  React.useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  const showOrderId = React.useCallback(async (id: string, signal?: AbortSignal) => {
    const known = ordersRef.current.find((o) => o.id === id);
    if (known) {
      setDetail(known);
      return;
    }
    // Not in the loaded page (older than ORDER_LIMIT, or a cold load that
    // raced the list) — fetch it directly.
    try {
      setDetail(await receivingApi.getOrder(id, { signal }));
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      // Unknown, deleted, or malformed id — fall back to the plain list
      // rather than leaving a dead URL in the address bar.
      setDetail(null);
      window.history.replaceState(null, '', LIST_PATH);
    }
  }, []);

  const openDetail = React.useCallback((order: Order) => {
    setDetail(order);
    window.history.pushState(null, '', orderPath(order.id));
  }, []);

  const closeDetail = React.useCallback(() => {
    setDetail(null);
    if (orderIdFromPath(window.location.pathname)) {
      window.history.pushState(null, '', LIST_PATH);
    }
  }, []);

  // Cold load / refresh on /receiving/<id>.
  React.useEffect(() => {
    if (!initialOrderId) return;
    const ctrl = new AbortController();
    void showOrderId(initialOrderId, ctrl.signal);
    return () => ctrl.abort();
  }, [initialOrderId, showOrderId]);

  // Back / forward between the list and an open order.
  React.useEffect(() => {
    const onPop = () => {
      const id = orderIdFromPath(window.location.pathname);
      if (id) void showOrderId(id);
      else setDetail(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [showOrderId]);

  // The server did the searching, filtering and slicing — ``orders`` IS the
  // page. The count it paginates over is the server's total for the same
  // question, not the number of rows that happened to arrive.
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const startIdx = (page - 1) * pageSize;

  // Deleting the last row of the last page leaves you on a page that no longer
  // exists; step back rather than showing an empty table.
  React.useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  return (
    <>
      <PageHeader
        title="Receipt Admin"
        subtitle="Multi-item orders received over time — place an order, then draw it down with dated, e-signed partial or blanket receipts."
        actions={
          <>
            {/* Retention lives beside the list it prunes, not in a settings
                screen — the person who notices the list is unwieldy is the one
                who should be able to do something about it. */}
            <Button onClick={() => setArchiveOpen(true)}>
              <Archive size={14} /> Archive
            </Button>
            {canCreate && (
              <Button variant="primary" onClick={() => setIntakeOpen(true)}>
                <Plus size={14} /> New Order
              </Button>
            )}
          </>
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="p-4">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {/* Tick the statuses you want (DATA-003). Open + partially
                received are on by default — the orders that still need
                something from someone. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="w-[240px] justify-between font-normal">
                  <span className="truncate">{statusSummary}</span>
                  <ChevronDown size={14} className="ml-2 shrink-0 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[240px]">
                <DropdownMenuLabel>Status</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {ALL_STATUSES.map((s) => (
                  <DropdownMenuCheckboxItem
                    key={s}
                    checked={statuses.includes(s)}
                    // Radix closes on select by default; a multi-select that
                    // shuts after one tick makes choosing two a chore.
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={(on) =>
                      setStatuses((prev) =>
                        on ? [...prev, s] : prev.filter((x) => x !== s),
                      )
                    }
                  >
                    {ORDER_STATUS_LABEL[s]}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setStatuses([...ALL_STATUSES])}>
                  Select all
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setStatuses([...DEFAULT_STATUSES])}>
                  Reset to default
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="w-full sm:w-[280px]">
              <Input
                icon={Search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by order #, item or lot…"
                aria-label="Search orders by order number, item or lot"
                trailing={
                  query ? (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      aria-label="Clear search"
                      className="shrink-0 text-text-3 hover:text-text"
                    >
                      <X size={14} />
                    </button>
                  ) : undefined
                }
              />
            </div>
          </div>

          {loadError && (
            <p
              role="alert"
              className="border-danger/30 bg-danger/5 mb-3 rounded-md border px-3 py-2 text-sm text-danger"
            >
              {loadError}
            </p>
          )}

          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : orders.length === 0 ? (
            <EmptyState
              icon={Truck}
              title="No orders yet"
              hint={
                canCreate
                  ? 'Create an order to place items and receive them over time.'
                  : 'Orders will appear here once created.'
              }
              action={
                canCreate ? (
                  <Button variant="primary" onClick={() => setIntakeOpen(true)}>
                    <Plus size={14} /> New Order
                  </Button>
                ) : undefined
              }
            />
          ) : orders.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No matching orders"
              hint={`Nothing matches “${query.trim()}”. Try a different order number, item or lot.`}
            />
          ) : (
            <>
              <ReceiptTransactionsTable
                orders={orders}
                canReceive={canReceive}
                onView={openDetail}
                onReceive={setReceiveTarget}
              />
              {/* The "showing the 200 most recent" caveat that used to live
                  here is gone: search and paging now run over every Order, so
                  there is no hidden tail to warn about. */}
              <ReceiptPagination
                total={total}
                page={page}
                pageCount={pageCount}
                pageSize={pageSize}
                startIdx={startIdx}
                rowsOnPage={orders.length}
                onPage={setPage}
                onPageSize={setPageSize}
              />
            </>
          )}
        </Card>
      </div>

      <ReceiptIntakeDialog open={intakeOpen} onOpenChange={setIntakeOpen} onCreated={upsert} />

      {/* Archiving moves orders between the working list and the shelf, so the
          list behind the panel has to be re-read when it does. */}
      <ArchivePanel
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        onChanged={() => void load()}
        // Viewing an archived order hands it to the SAME sheet the working list
        // uses, so it reads exactly as it always has — with a way back, since
        // the operator was midway through a search when they opened it.
        onView={(order) => {
          setArchiveOpen(false);
          setCameFromArchive(true);
          openDetail(order);
        }}
      />

      <ReceiveDialog
        open={receiveTarget !== null}
        onOpenChange={(o) => !o && setReceiveTarget(null)}
        order={receiveTarget}
        onReceived={(order) => {
          upsert(order);
          setReceiveTarget(null);
        }}
      />

      <OrderDetailSheet
        order={detail}
        canCreate={canCreate}
        canReceive={canReceive}
        onUpdated={upsert}
        onRemoved={(id) => {
          removeOrder(id);
          closeDetail();
        }}
        onReceive={(order) => {
          closeDetail();
          setReceiveTarget(order);
        }}
        onOpenChange={(o) => {
          if (o) return;
          closeDetail();
          // ✕ / Esc means "done", not "go back" — drop the return trip so the
          // archive doesn't reappear behind a sheet the operator just dismissed.
          setCameFromArchive(false);
        }}
        onBack={
          cameFromArchive
            ? () => {
                closeDetail();
                setCameFromArchive(false);
                setArchiveOpen(true);
              }
            : undefined
        }
      />
    </>
  );
}

// ── Pagination ───────────────────────────────────────────────────────────

function ReceiptPagination({
  total,
  page,
  pageCount,
  pageSize,
  startIdx,
  rowsOnPage,
  onPage,
  onPageSize,
}: {
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  startIdx: number;
  rowsOnPage: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}) {
  const pages = React.useMemo<Array<number | '…'>>(() => {
    if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
    const set = new Set<number>([1, pageCount, page, page - 1, page + 1]);
    if (page <= 3) [2, 3, 4].forEach((n) => set.add(n));
    if (page >= pageCount - 2)
      [pageCount - 1, pageCount - 2, pageCount - 3].forEach((n) => set.add(n));
    const ordered = [...set].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
    const out: Array<number | '…'> = [];
    ordered.forEach((p, i) => {
      const prev = ordered[i - 1];
      if (prev !== undefined && p - prev > 1) out.push('…');
      out.push(p);
    });
    return out;
  }, [pageCount, page]);

  return (
    <nav aria-label="Pagination" className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <div className="text-xs text-text-3">
        Showing{' '}
        <strong className="text-text-2">
          {startIdx + 1}–{startIdx + rowsOnPage}
        </strong>{' '}
        of <strong className="text-text-2">{total.toLocaleString()}</strong> orders
      </div>

      <div className="flex items-center gap-3">
        <label className="inline-flex items-center gap-2 text-xs text-text-3">
          Rows per page
          <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
            <SelectTrigger className="h-7 w-[78px] text-xs" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <div className="inline-flex gap-1">
          <Button
            size="icon-sm"
            variant="default"
            onClick={() => onPage(Math.max(1, page - 1))}
            disabled={page === 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={13} />
          </Button>
          {pages.map((p, i) =>
            p === '…' ? (
              <span
                key={`e${i}`}
                className="grid h-7 min-w-7 place-items-center text-xs text-text-3"
                aria-hidden
              >
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => onPage(p)}
                aria-current={p === page ? 'page' : undefined}
                className={cn(
                  'h-7 min-w-7 rounded-md border px-2 text-xs font-medium transition-colors',
                  p === page
                    ? 'cursor-default border-text bg-text text-bg'
                    : 'border-border-strong bg-bg-elev text-text-2 hover:bg-surface',
                )}
              >
                {p}
              </button>
            ),
          )}
          <Button
            size="icon-sm"
            variant="default"
            onClick={() => onPage(Math.min(pageCount, page + 1))}
            disabled={page === pageCount}
            aria-label="Next page"
          >
            <ChevronRight size={13} />
          </Button>
        </div>
      </div>
    </nav>
  );
}

// ── Detail sheet ─────────────────────────────────────────────────────────

function OrderDetailSheet({
  order,
  canCreate,
  canReceive,
  onUpdated,
  onRemoved,
  onReceive,
  onOpenChange,
  onBack,
}: {
  order: Order | null;
  canCreate: boolean;
  canReceive: boolean;
  onUpdated: (order: Order) => void;
  onRemoved: (id: string) => void;
  onReceive: (order: Order) => void;
  onOpenChange: (open: boolean) => void;
  /** Set when this sheet was opened from somewhere that should be returned to
   *  — the archive panel. Shows a Back control; closing with ✕ still just
   *  closes, because "go back" and "I'm done" are different intentions. */
  onBack?: () => void;
}) {
  // Local copy so an edit can refresh the sheet in place.
  const [current, setCurrent] = React.useState<Order | null>(order);
  const [editOrder, setEditOrder] = React.useState<Order | null>(null);
  const [editLotId, setEditLotId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Cancel / delete are e-signed: this drives one shared reauth dialog.
  const [reauthAction, setReauthAction] = React.useState<'cancel' | 'delete' | null>(null);

  React.useEffect(() => setCurrent(order), [order]);

  const isOpen = current?.status === 'open';

  const performCancel = async (evidence: ReauthResponse) => {
    if (!current) return;
    setBusy(true);
    try {
      const updated = await receivingApi.cancelOrder(current.id, evidence.evidence_id);
      setCurrent(updated);
      onUpdated(updated);
    } catch {
      /* surfaced by the list reload; keep the sheet open */
    } finally {
      setBusy(false);
    }
  };

  // After an e-signed lot edit, re-fetch the order so lines + history (and any
  // resulting status change, e.g. received → partially_received after a qty
  // reduction) reflect in both the sheet and the parent list/table.
  const refreshAfterLotEdit = async () => {
    if (!current) return;
    try {
      const fresh = await receivingApi.getOrder(current.id);
      setCurrent(fresh);
      onUpdated(fresh);
    } catch {
      /* the list reload / next open will reconcile; keep the sheet open */
    }
  };

  const performDelete = async (evidence: ReauthResponse) => {
    if (!current) return;
    setBusy(true);
    try {
      await receivingApi.deleteOrder(current.id, evidence.evidence_id);
      onRemoved(current.id);
    } catch {
      /* keep the sheet open on failure */
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Sheet open={order !== null} onOpenChange={onOpenChange}>
        <SheetContent className="w-[560px] sm:max-w-[560px]">
          {current && (
            <>
              <SheetHeader>
                {onBack && (
                  <button
                    type="button"
                    onClick={onBack}
                    className="-ml-1 mb-1 inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 text-xs text-text-3 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <ChevronLeft size={13} aria-hidden /> Back to archive
                  </button>
                )}
                <SheetTitle>
                  <span className="font-mono text-sm text-accent">{current.po_reference}</span>{' '}
                  <Badge tone={STATUS_TONE[current.status]} dot className="ml-1 align-middle">
                    {ORDER_STATUS_LABEL[current.status]}
                  </Badge>
                  {current.is_blanket && (
                    <Badge tone="accent" className="ml-1 align-middle">
                      Blanket
                    </Badge>
                  )}
                </SheetTitle>
                <SheetDescription>
                  {current.is_blanket && (current.valid_from || current.valid_to)
                    ? `Valid ${current.valid_from ?? '…'} → ${current.valid_to ?? '…'}`
                    : 'Standard order'}
                </SheetDescription>
              </SheetHeader>

              <SheetBody className="space-y-5">
                {/* Action bar */}
                <div className="flex flex-wrap gap-2">
                  {canReceive &&
                    (current.status === 'open' || current.status === 'partially_received') && (
                      <Button size="sm" variant="primary" onClick={() => onReceive(current)}>
                        <PackageCheck size={14} /> Receive
                      </Button>
                    )}
                  {canCreate && isOpen && (
                    <Button size="sm" variant="default" onClick={() => setEditOrder(current)}>
                      <Pencil size={13} /> Edit
                    </Button>
                  )}
                  {canCreate && isOpen && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setReauthAction('cancel')}
                      disabled={busy}
                    >
                      <XCircle size={13} /> Cancel order
                    </Button>
                  )}
                  {canCreate && isOpen && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setReauthAction('delete')}
                      disabled={busy}
                    >
                      <Trash2 size={13} /> Delete
                    </Button>
                  )}
                </div>

                {/* Lines */}
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-3">
                    Lines
                  </h3>
                  <div className="space-y-2">
                    {current.lines.map((l) => (
                      <div
                        key={l.id}
                        className="rounded-md border border-border bg-surface p-3 text-sm"
                      >
                        <div className="flex items-center justify-between">
                          <ItemLink
                            itemNumber={l.item_number}
                            itemId={l.item_id}
                            className="font-mono text-xs"
                          />
                          <span className="text-xs text-text-3">{l.supplier_name ?? '—'}</span>
                        </div>
                        {l.item_description && (
                          <p className="mt-0.5 text-text-2">{l.item_description}</p>
                        )}
                        <dl className="mt-2 grid grid-cols-4 gap-2 text-xs">
                          <div>
                            <dt className="text-text-3">Ordered</dt>
                            <dd className="font-mono tabular-nums">{l.ordered_qty}</dd>
                          </div>
                          <div>
                            <dt className="text-text-3">Received</dt>
                            <dd className="font-mono tabular-nums">{l.received_qty}</dd>
                          </div>
                          <div>
                            <dt className="text-text-3">Outstanding</dt>
                            <dd className="font-mono tabular-nums">{l.outstanding_qty}</dd>
                          </div>
                          <div>
                            <dt className="text-text-3">Unit price</dt>
                            <dd className="font-mono tabular-nums">{l.unit_price_amount ?? '—'}</dd>
                          </div>
                        </dl>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Receive lots */}
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-3">
                    Receive lots
                  </h3>
                  {current.events.length === 0 ? (
                    <p className="text-sm text-text-3">No receipts yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {current.events.map((ev) => (
                        <div
                          key={ev.id}
                          className="rounded-md border border-border bg-surface p-3 text-sm"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-text-2">{ev.received_at}</span>
                            <span className="text-xs text-text-3">
                              by{' '}
                              {ev.received_by_user_name ?? `${ev.received_by_user_id.slice(0, 8)}…`}
                            </span>
                          </div>
                          <ul className="mt-2 space-y-1 text-xs">
                            {ev.lines.map((el) => {
                              const orderLine = current.lines.find((l) => l.id === el.line_id);
                              return (
                                <li key={el.id} className="flex flex-wrap items-center gap-2">
                                  <span className="font-mono text-accent">
                                    {el.lot_number ?? '—'}
                                  </span>
                                  {orderLine && (
                                    <span className="text-text-2">
                                      <ItemLink
                                        itemNumber={orderLine.item_number}
                                        itemId={orderLine.item_id}
                                        className="font-mono"
                                      />
                                      {orderLine.item_description
                                        ? ` — ${orderLine.item_description}`
                                        : ''}
                                    </span>
                                  )}
                                  <span className="tabular-nums text-text-2">
                                    +{el.qty_received}
                                  </span>
                                  {orderLine?.supplier_name && (
                                    <span className="text-text-3">({orderLine.supplier_name})</span>
                                  )}
                                  {el.over_receipt_reason && (
                                    <span className="text-warning">
                                      over: {el.over_receipt_reason}
                                    </span>
                                  )}
                                  {canReceive && el.lot_id && (
                                    <Button
                                      size="icon-sm"
                                      variant="ghost"
                                      className="ml-auto"
                                      onClick={() => setEditLotId(el.lot_id)}
                                      aria-label={`Edit lot ${el.lot_number ?? ''}`}
                                    >
                                      <Pencil size={12} />
                                    </Button>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>

      <OrderEditDialog
        order={editOrder}
        onOpenChange={(o) => !o && setEditOrder(null)}
        onSaved={(updated) => {
          setEditOrder(null);
          setCurrent(updated);
          onUpdated(updated);
        }}
      />

      <LotDetailEditDialog
        lotId={editLotId}
        onOpenChange={(o) => !o && setEditLotId(null)}
        onSaved={() => {
          setEditLotId(null);
          void refreshAfterLotEdit();
        }}
      />

      <PasswordReauthDialog
        open={reauthAction !== null}
        onOpenChange={(o) => !o && setReauthAction(null)}
        action={reauthAction === 'delete' ? 'order.delete' : 'order.cancel'}
        recordTable="app.receipt_transactions"
        recordId={current?.id}
        meaning={
          reauthAction === 'delete'
            ? `I am deleting order ${current?.po_reference ?? ''}.`
            : `I am cancelling order ${current?.po_reference ?? ''}.`
        }
        commentPlaceholder={
          reauthAction === 'delete'
            ? 'e.g. Order created in error'
            : 'e.g. Supplier cancelled the order'
        }
        onConfirmed={(evidence) => {
          const action = reauthAction;
          setReauthAction(null);
          if (action === 'delete') void performDelete(evidence);
          else void performCancel(evidence);
        }}
        title={reauthAction === 'delete' ? 'Sign this deletion' : 'Sign this cancellation'}
        submitLabel={reauthAction === 'delete' ? 'Sign & delete' : 'Sign & cancel'}
      />
    </>
  );
}
