'use client';

import * as React from 'react';
import {
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

import { ReceiptTransactionsTable } from './receipt-transactions-table';
import { ReceiptIntakeDialog } from './receipt-intake-dialog';
import { ReceiveDialog } from './receive-dialog';
import { OrderEditDialog } from './lot-edit-dialog';
import { LotDetailEditDialog } from './lot-detail-edit-dialog';

const STATUS_ALL = '__all__';
const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
// Search and pagination run client-side over the loaded set; the backend has no
// text-search param. This caps how many (most-recent) rows that set covers.
const ORDER_LIMIT = 200;

const STATUS_TONE: Record<OrderStatus, BadgeTone> = {
  open: 'accent',
  partially_received: 'warning',
  received: 'success',
  cancelled: 'neutral',
};

export function ReceivingPageClient() {
  const canCreate = usePermission('inventory', 'create');
  const canReceive = usePermission('inventory', 'sign');

  const [orders, setOrders] = React.useState<Order[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<
    OrderStatus | typeof STATUS_ALL
  >(STATUS_ALL);

  const [query, setQuery] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState<number>(PAGE_SIZE_OPTIONS[0]);

  const [intakeOpen, setIntakeOpen] = React.useState(false);
  const [receiveTarget, setReceiveTarget] = React.useState<Order | null>(null);
  const [detail, setDetail] = React.useState<Order | null>(null);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const resp = await receivingApi.listOrders({
          status: statusFilter === STATUS_ALL ? undefined : statusFilter,
          limit: ORDER_LIMIT,
          signal,
        });
        setOrders(resp.items);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load orders.',
        );
      } finally {
        setLoading(false);
      }
    },
    [statusFilter],
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

  // Client-side search across po_reference, item number/description on lines
  // and lot numbers across receive events.
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((o) => {
      const haystacks: Array<string | null> = [o.po_reference];
      for (const l of o.lines) {
        haystacks.push(l.item_number, l.item_description);
      }
      for (const ev of o.events) {
        for (const el of ev.lines) haystacks.push(el.lot_number);
      }
      return haystacks.some((s) => s?.toLowerCase().includes(q));
    });
  }, [orders, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const startIdx = (safePage - 1) * pageSize;
  const paged = filtered.slice(startIdx, startIdx + pageSize);

  React.useEffect(() => {
    setPage(1);
  }, [query, statusFilter, pageSize]);

  React.useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  return (
    <>
      <PageHeader
        title="Receipt Admin"
        subtitle="Multi-item orders received over time — place an order, then draw it down with dated, e-signed partial or blanket receipts."
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setIntakeOpen(true)}>
              <Plus size={14} /> New Order
            </Button>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="p-4">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Select
              value={statusFilter}
              onValueChange={(v) =>
                setStatusFilter(v as OrderStatus | typeof STATUS_ALL)
              }
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={STATUS_ALL}>All statuses</SelectItem>
                {(
                  [
                    'open',
                    'partially_received',
                    'received',
                    'cancelled',
                  ] as const
                ).map((s) => (
                  <SelectItem key={s} value={s}>
                    {ORDER_STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

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
              className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
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
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No matching orders"
              hint={`Nothing matches “${query.trim()}”. Try a different order number, item or lot.`}
            />
          ) : (
            <>
              <ReceiptTransactionsTable
                orders={paged}
                canReceive={canReceive}
                onView={setDetail}
                onReceive={setReceiveTarget}
              />
              {orders.length >= ORDER_LIMIT && (
                <p className="mt-3 text-xs text-text-3">
                  Showing the {ORDER_LIMIT} most recent orders — search and paging
                  cover these only.
                </p>
              )}
              <ReceiptPagination
                total={filtered.length}
                page={safePage}
                pageCount={pageCount}
                pageSize={pageSize}
                startIdx={startIdx}
                rowsOnPage={paged.length}
                onPage={setPage}
                onPageSize={setPageSize}
              />
            </>
          )}
        </Card>
      </div>

      <ReceiptIntakeDialog
        open={intakeOpen}
        onOpenChange={setIntakeOpen}
        onCreated={upsert}
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
          setDetail(null);
        }}
        onReceive={(order) => {
          setDetail(null);
          setReceiveTarget(order);
        }}
        onOpenChange={(o) => !o && setDetail(null)}
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
    <nav
      aria-label="Pagination"
      className="mt-3 flex flex-wrap items-center justify-between gap-3"
    >
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
}: {
  order: Order | null;
  canCreate: boolean;
  canReceive: boolean;
  onUpdated: (order: Order) => void;
  onRemoved: (id: string) => void;
  onReceive: (order: Order) => void;
  onOpenChange: (open: boolean) => void;
}) {
  // Local copy so an edit can refresh the sheet in place.
  const [current, setCurrent] = React.useState<Order | null>(order);
  const [editOrder, setEditOrder] = React.useState<Order | null>(null);
  const [editLotId, setEditLotId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Cancel / delete are e-signed: this drives one shared reauth dialog.
  const [reauthAction, setReauthAction] = React.useState<'cancel' | 'delete' | null>(
    null,
  );

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
                <SheetTitle>
                  <span className="font-mono text-sm text-accent">
                    {current.po_reference}
                  </span>{' '}
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
                    (current.status === 'open' ||
                      current.status === 'partially_received') && (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => onReceive(current)}
                      >
                        <PackageCheck size={14} /> Receive
                      </Button>
                    )}
                  {canCreate && isOpen && (
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => setEditOrder(current)}
                    >
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
                          <span className="font-mono text-xs text-accent">
                            {l.item_number ?? '—'}
                          </span>
                          <span className="text-xs text-text-3">
                            {l.supplier_name ?? '—'}
                          </span>
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
                            <dd className="font-mono tabular-nums">
                              {l.outstanding_qty}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-text-3">Unit price</dt>
                            <dd className="font-mono tabular-nums">
                              {l.unit_price_amount ?? '—'}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Receive history */}
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-3">
                    Receive history
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
                            <span className="font-medium text-text-2">
                              {ev.received_at}
                            </span>
                            <span className="text-xs text-text-3">
                              by {ev.received_by_user_id.slice(0, 8)}…
                            </span>
                          </div>
                          <ul className="mt-2 space-y-1 text-xs">
                            {ev.lines.map((el) => {
                              const orderLine = current.lines.find(
                                (l) => l.id === el.line_id,
                              );
                              return (
                                <li
                                  key={el.id}
                                  className="flex flex-wrap items-center gap-2"
                                >
                                  <span className="font-mono text-accent">
                                    {el.lot_number ?? '—'}
                                  </span>
                                  {orderLine && (
                                    <span className="text-text-2">
                                      <span className="font-mono">
                                        {orderLine.item_number ?? '—'}
                                      </span>
                                      {orderLine.item_description
                                        ? ` — ${orderLine.item_description}`
                                        : ''}
                                    </span>
                                  )}
                                  <span className="tabular-nums text-text-2">
                                    +{el.qty_received}
                                  </span>
                                  {orderLine?.supplier_name && (
                                    <span className="text-text-3">
                                      ({orderLine.supplier_name})
                                    </span>
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
