'use client';

import * as React from 'react';
import { Plus, Truck } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
import { ApiError } from '@/lib/api/client';
import {
  receivingApi,
  RECEIPT_STATUS_LABEL,
  type ReceiptTransaction,
  type ReceiptTransactionStatus,
} from '@/lib/api/receiving';

import { ReceiptTransactionsTable } from './receipt-transactions-table';
import { ReceiptIntakeDialog } from './receipt-intake-dialog';
import { ReceiveDialog } from './receive-dialog';

const STATUS_ALL = '__all__';

export function ReceivingPageClient() {
  const canCreate = usePermission('inventory', 'create');
  const canReceive = usePermission('inventory', 'sign');

  const [transactions, setTransactions] = React.useState<ReceiptTransaction[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<
    ReceiptTransactionStatus | typeof STATUS_ALL
  >(STATUS_ALL);

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
          limit: 200,
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
                {(['open', 'received', 'cancelled'] as const).map((s) => (
                  <SelectItem key={s} value={s}>
                    {RECEIPT_STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          ) : (
            <ReceiptTransactionsTable
              transactions={transactions}
              canReceive={canReceive}
              onView={setDetail}
              onReceive={setReceiveTarget}
            />
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
        onOpenChange={(o) => !o && setDetail(null)}
      />
    </>
  );
}

// ── Detail sheet ─────────────────────────────────────────────────────────

function TransactionDetailSheet({
  transaction,
  onOpenChange,
}: {
  transaction: ReceiptTransaction | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={transaction !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-[480px] sm:max-w-[480px]">
        {transaction && (
          <>
            <SheetHeader>
              <SheetTitle>
                <span className="font-mono text-sm text-accent">
                  {transaction.item_number}
                </span>{' '}
                <Badge
                  tone={
                    transaction.status === 'received'
                      ? 'success'
                      : transaction.status === 'open'
                        ? 'accent'
                        : 'neutral'
                  }
                  dot
                  className="ml-1 align-middle"
                >
                  {RECEIPT_STATUS_LABEL[transaction.status]}
                </Badge>
              </SheetTitle>
              <SheetDescription>
                {transaction.item_description ?? ''}
                {transaction.po_reference ? ` · PO ${transaction.po_reference}` : ''}
              </SheetDescription>
            </SheetHeader>
            <SheetBody className="space-y-3">
              {transaction.lots.length === 0 && (
                <p className="text-sm text-text-3">No lots on this transaction.</p>
              )}
              {transaction.lots.map((lot) => (
                <div
                  key={lot.id}
                  className="rounded-md border border-border bg-surface p-3 text-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-accent">
                      {lot.lot_number}
                    </span>
                    <Badge tone={lot.status === 'available' ? 'success' : 'accent'}>
                      {lot.status === 'available' ? 'Available' : 'On order'}
                    </Badge>
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
                  {(lot.unverified_vendor_for_item ||
                    lot.vendor_not_previously_associated_with_item) && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {lot.unverified_vendor_for_item && (
                        <Badge tone="warning">Unverified vendor</Badge>
                      )}
                      {lot.vendor_not_previously_associated_with_item && (
                        <Badge tone="warning">New vendor for item</Badge>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
