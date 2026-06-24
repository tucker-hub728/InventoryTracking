'use client';

import * as React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Search,
  Truck,
  X,
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
import { usePermission } from '@/hooks/use-permission';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import {
  receivingApi,
  RECEIPT_STATUS_LABEL,
  type ReceiptTransaction,
  type ReceiptTransactionStatus,
} from '@/lib/api/receiving';

import type { Lot } from '@/lib/api/lots';

import { ReceiptTransactionsTable } from './receipt-transactions-table';
import { ReceiptIntakeDialog } from './receipt-intake-dialog';
import { ReceiveDialog } from './receive-dialog';
import { LotEditDialog } from './lot-edit-dialog';

const STATUS_ALL = '__all__';
const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
// Search and pagination run client-side over the loaded set; the backend has no
// text-search param. This caps how many (most-recent) rows that set covers — we
// surface a notice when the cap is actually reached so it isn't silent.
const TXN_LIMIT = 200;

export function ReceivingPageClient() {
  const canCreate = usePermission('inventory', 'create');
  const canReceive = usePermission('inventory', 'sign');

  const [transactions, setTransactions] = React.useState<ReceiptTransaction[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<
    ReceiptTransactionStatus | typeof STATUS_ALL
  >(STATUS_ALL);

  const [query, setQuery] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState<number>(PAGE_SIZE_OPTIONS[0]);

  const [intakeOpen, setIntakeOpen] = React.useState(false);
  const [receiveTarget, setReceiveTarget] = React.useState<ReceiptTransaction | null>(
    null,
  );
  const [detail, setDetail] = React.useState<ReceiptTransaction | null>(null);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const resp = await receivingApi.listTransactions({
          status: statusFilter === STATUS_ALL ? undefined : statusFilter,
          limit: TXN_LIMIT,
          signal,
        });
        setTransactions(resp.items);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load receipts.',
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

  const upsert = (txn: ReceiptTransaction) =>
    setTransactions((prev) => {
      const i = prev.findIndex((t) => t.id === txn.id);
      if (i === -1) return [txn, ...prev];
      const next = [...prev];
      next[i] = txn;
      return next;
    });

  // Client-side search across item number/description, PO ref and any lot
  // number on the transaction. The list is loaded whole (status-filtered on the
  // server), so filtering and paging here keep the toolbar snappy.
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return transactions;
    return transactions.filter((t) => {
      const haystacks = [
        t.item_number,
        t.item_description,
        t.po_reference,
        ...t.lots.map((l) => l.lot_number),
      ];
      return haystacks.some((s) => s?.toLowerCase().includes(q));
    });
  }, [transactions, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  // Clamp for display/slicing so a stale page (e.g. just after a search narrows
  // the set) never renders an out-of-range, empty page before the effects fire.
  const safePage = Math.min(page, pageCount);
  const startIdx = (safePage - 1) * pageSize;
  const paged = filtered.slice(startIdx, startIdx + pageSize);

  // Snap back to page 1 whenever the result set changes shape (new search,
  // status switch or page-size change).
  React.useEffect(() => {
    setPage(1);
  }, [query, statusFilter, pageSize]);

  // Keep the current page in range if the filtered set shrinks under it.
  React.useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  return (
    <>
      <PageHeader
        title="Receipt Admin"
        subtitle="Order intake and physical receipt — on-order lots become available stock, with vendor and price captured per lot."
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setIntakeOpen(true)}>
              <Plus size={14} /> New intake
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
                setStatusFilter(v as ReceiptTransactionStatus | typeof STATUS_ALL)
              }
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={STATUS_ALL}>All statuses</SelectItem>
                {(['open', 'received'] as const).map((s) => (
                  <SelectItem key={s} value={s}>
                    {RECEIPT_STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="w-full sm:w-[280px]">
              <Input
                icon={Search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by item or lot…"
                aria-label="Search receipts by item or lot"
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
          ) : transactions.length === 0 ? (
            <EmptyState
              icon={Truck}
              title="No receipt transactions yet"
              hint={
                canCreate
                  ? 'Create an intake to place an order and track it through to receipt.'
                  : 'Intakes will appear here once created.'
              }
              action={
                canCreate ? (
                  <Button variant="primary" onClick={() => setIntakeOpen(true)}>
                    <Plus size={14} /> New intake
                  </Button>
                ) : undefined
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No matching receipts"
              hint={`Nothing matches “${query.trim()}”. Try a different item number or lot.`}
            />
          ) : (
            <>
              <ReceiptTransactionsTable
                transactions={paged}
                canReceive={canReceive}
                onView={setDetail}
                onReceive={setReceiveTarget}
              />
              {transactions.length >= TXN_LIMIT && (
                <p className="mt-3 text-xs text-text-3">
                  Showing the {TXN_LIMIT} most recent receipts — search and paging
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
        transaction={receiveTarget}
        onReceived={(txn) => {
          upsert(txn);
          setReceiveTarget(null);
        }}
      />

      <TransactionDetailSheet
        transaction={detail}
        canEdit={canReceive}
        onUpdated={upsert}
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
  // Compact page list with ellipses for long ranges (1 … 4 5 6 … 20).
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
        of <strong className="text-text-2">{total.toLocaleString()}</strong> receipts
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

function TransactionDetailSheet({
  transaction,
  canEdit,
  onUpdated,
  onOpenChange,
}: {
  transaction: ReceiptTransaction | null;
  canEdit: boolean;
  onUpdated: (txn: ReceiptTransaction) => void;
  onOpenChange: (open: boolean) => void;
}) {
  // Local copy so a lot edit can refresh the sheet in place without waiting
  // for the parent to re-fetch.
  const [txn, setTxn] = React.useState<ReceiptTransaction | null>(transaction);
  const [editLot, setEditLot] = React.useState<Lot | null>(null);

  React.useEffect(() => setTxn(transaction), [transaction]);

  const refresh = React.useCallback(async () => {
    if (!txn) return;
    try {
      const fresh = await receivingApi.getTransaction(txn.id);
      setTxn(fresh);
      onUpdated(fresh);
    } catch {
      /* keep the stale view; the edit toast already confirmed success */
    }
  }, [txn, onUpdated]);

  return (
    <>
      <Sheet open={transaction !== null} onOpenChange={onOpenChange}>
        <SheetContent className="w-[480px] sm:max-w-[480px]">
          {txn && (
            <>
              <SheetHeader>
                <SheetTitle>
                  <span className="font-mono text-sm text-accent">
                    {txn.item_number}
                  </span>{' '}
                  <Badge
                    tone={
                      txn.status === 'received'
                        ? 'success'
                        : txn.status === 'open'
                          ? 'accent'
                          : 'neutral'
                    }
                    dot
                    className="ml-1 align-middle"
                  >
                    {RECEIPT_STATUS_LABEL[txn.status]}
                  </Badge>
                </SheetTitle>
                <SheetDescription>
                  {txn.item_description ?? ''}
                  {txn.po_reference ? ` · PO ${txn.po_reference}` : ''}
                </SheetDescription>
              </SheetHeader>
              <SheetBody className="space-y-3">
                {txn.lots.length === 0 && (
                  <p className="text-sm text-text-3">No lots on this transaction.</p>
                )}
                {txn.lots.map((lot) => (
                  <div
                    key={lot.id}
                    className="rounded-md border border-border bg-surface p-3 text-sm"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-accent">
                        {lot.lot_number}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Badge tone={lot.status === 'available' ? 'success' : 'accent'}>
                          {lot.status === 'available' ? 'Available' : 'On order'}
                        </Badge>
                        {canEdit && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditLot(lot)}
                            aria-label={`Edit lot ${lot.lot_number}`}
                          >
                            <Pencil size={13} />
                          </Button>
                        )}
                      </div>
                    </div>
                    <dl className="mt-2 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-text-3">Vendor</dt>
                      <dd>{lot.vendor_name ?? '—'}</dd>
                      <dt className="text-text-3">Ordered</dt>
                      <dd className="font-mono">{lot.ordered_qty ?? '—'}</dd>
                      <dt className="text-text-3">Unit price</dt>
                      <dd className="font-mono">{lot.unit_price_amount ?? '—'}</dd>
                      {lot.parent_lot_id && (
                        <>
                          <dt className="text-text-3">Split from</dt>
                          <dd className="font-mono">{lot.parent_lot_id.slice(0, 8)}…</dd>
                        </>
                      )}
                    </dl>
                  </div>
                ))}
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>

      <LotEditDialog
        lot={editLot}
        onOpenChange={(o) => !o && setEditLot(null)}
        onSaved={() => {
          setEditLot(null);
          void refresh();
        }}
      />
    </>
  );
}
