'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Download, ArrowLeftRight, Hash, ArrowRight, ArrowDownToLine, Search } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TransactionDetailSheet } from '@/components/transactions/transaction-detail-sheet';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import { itemsApi, type ApiItemDetail, type ApiItemLedgerEntry } from '@/lib/api/items';
import { locationsApi, type ApiLocation } from '@/lib/api/locations';
import { toNum } from '@/lib/api/helpers';
import { transactionTypeLabel, transactionTypeTone } from '@/lib/transaction-display';
import { EditItemDialog } from './edit-item-dialog';
import { ReceiveMaterialDialog } from './receive-material-dialog';
import { TransferMaterialDialog } from './transfer-material-dialog';

export function ItemDetailClient({ itemId }: { itemId: string }) {
  const router = useRouter();
  const canEdit = usePermission('items', 'edit');
  const canTransact = usePermission('transactions', 'create');

  const [item, setItem] = React.useState<ApiItemDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [locations, setLocations] = React.useState<ApiLocation[]>([]);
  const [txns, setTxns] = React.useState<ApiItemLedgerEntry[]>([]);

  const [editOpen, setEditOpen] = React.useState(false);
  const [receiveOpen, setReceiveOpen] = React.useState(false);
  const [transferOpen, setTransferOpen] = React.useState(false);
  // Selected transaction to show in the side sheet (from Recent transactions).
  const [detailTxnId, setDetailTxnId] = React.useState<string | null>(null);
  // Client-side search over the "Inventory by location" rows.
  const [stockSearch, setStockSearch] = React.useState('');

  const filteredStock = React.useMemo(() => {
    const rows = item?.stock ?? [];
    const q = stockSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.location_name ?? '').toLowerCase().includes(q) ||
        (r.location_type ?? '').toLowerCase().includes(q) ||
        (r.lot_number ?? '').toLowerCase().includes(q),
    );
  }, [item?.stock, stockSearch]);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        setItem(await itemsApi.get(itemId, { signal }));
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        if (err instanceof ApiError && err.status === 404) {
          setError('This raw material no longer exists.');
        } else {
          setError(err instanceof ApiError ? err.message : 'Failed to load raw material.');
        }
      } finally {
        // An aborted request (StrictMode remount / itemId change) must NOT flip
        // loading off — otherwise the still-pending real fetch briefly renders
        // the "Not available" error state before its data arrives.
        if (!signal?.aborted) setLoading(false);
      }
    },
    [itemId],
  );

  const loadTxns = React.useCallback(
    async (signal?: AbortSignal) => {
      try {
        setTxns(await itemsApi.transactions(itemId, { limit: 25 }, { signal }));
      } catch {
        /* non-fatal — the tab shows its own empty state */
      }
    },
    [itemId],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    void loadTxns(ctrl.signal);
    return () => ctrl.abort();
  }, [load, loadTxns]);

  React.useEffect(() => {
    const ctrl = new AbortController();
    locationsApi
      .list({ active: true }, { signal: ctrl.signal })
      .then(setLocations)
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  const refresh = () => {
    void load();
    void loadTxns();
  };

  if (loading) {
    return <div className="px-8 py-16 text-center text-sm text-text-3">Loading…</div>;
  }
  if (error || !item) {
    return (
      <div className="px-8 py-16">
        <EmptyState
          title="Not available"
          hint={error ?? 'Unknown error.'}
          action={
            <Button onClick={() => router.push('/inventory/cr')}>Back to Raw Materials</Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title={item.item_name}
        crumbs={[{ label: 'Raw Materials', href: '/inventory/cr' }, { label: item.item_code }]}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{item.item_code}</span>
            <Badge tone="warning" dot>
              {item.tier} · Raw Material
            </Badge>
            {item.is_consumable && <Badge tone="accent">Consumable</Badge>}
            {!item.is_active && <Badge tone="neutral">Inactive</Badge>}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canTransact && (
              <Button variant="secondary" onClick={() => setReceiveOpen(true)}>
                <Download size={14} /> Receive
              </Button>
            )}
            {canTransact && (
              <Button variant="secondary" onClick={() => setTransferOpen(true)}>
                <ArrowLeftRight size={14} /> Transfer
              </Button>
            )}
            {canEdit && (
              <Button variant="secondary" onClick={() => setEditOpen(true)}>
                <Pencil size={14} /> Edit
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-6 px-6 py-6 sm:px-8">
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Metric label="On-hand" value={toNum(item.on_hand).toLocaleString()} suffix={item.unit_of_measure} />
          <Metric label="Locations" value={String(item.location_count)} />
          <Metric label="Unit" value={item.unit_of_measure} />
          <Metric label="Tier" value={item.tier} />
        </section>

        {item.description && (
          <p className="max-w-2xl text-sm text-text-2">{item.description}</p>
        )}

        <Tabs defaultValue="locations">
          <TabsList>
            <TabsTrigger value="locations">Inventory by location</TabsTrigger>
            <TabsTrigger value="transactions">Recent transactions</TabsTrigger>
          </TabsList>

          {/* Inventory by location */}
          <TabsContent value="locations">
            {item.stock.length === 0 ? (
              <EmptyState title="No stock on hand" hint="Receive this item to add stock." />
            ) : (
              <div className="space-y-3">
                <div className="w-full sm:max-w-xs">
                  <Input
                    icon={Search}
                    value={stockSearch}
                    onChange={(e) => setStockSearch(e.target.value)}
                    placeholder="Search location, category or lot…"
                    aria-label="Search stock by location"
                  />
                </div>

                {filteredStock.length === 0 ? (
                  <div className="rounded-lg border border-border py-10 text-center text-sm text-text-3">
                    No matching locations.
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {filteredStock.map((row, i) => (
                      <div
                        key={`${row.location_id}-${row.lot_number ?? 'nolot'}-${i}`}
                        className="flex items-center justify-between rounded-lg border border-border bg-bg-elev px-4 py-3"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {row.location_name ?? row.location_id}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-text-3">
                            {row.location_type && <span>{row.location_type}</span>}
                            {row.location_type && <span aria-hidden>·</span>}
                            <span>
                              {row.lot_number ? (
                                <>Lot <span className="font-mono">{row.lot_number}</span></>
                              ) : (
                                'No lot'
                              )}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <ExpiryPill iso={row.expiry_date} />
                          <div className="text-right tabular-nums">
                            <span className="text-sm font-semibold">
                              {toNum(row.quantity_available).toLocaleString()}
                            </span>{' '}
                            <span className="text-xs text-text-3">{row.unit_of_measure}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          {/* Recent transactions */}
          <TabsContent value="transactions">
            {txns.length === 0 ? (
              <EmptyState icon={Hash} title="No transactions yet" hint="Receipts and transfers for this item will show here." />
            ) : (
              <div className="grid gap-2">
                {txns.map((t) => (
                  <LedgerRow
                    key={t.transaction_id}
                    t={t}
                    onClick={() => setDetailTxnId(t.transaction_id)}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <EditItemDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        item={item}
        onSaved={(updated) => {
          toast.success('Raw material updated');
          setEditOpen(false);
          setItem((cur) => (cur ? { ...cur, ...updated } : cur));
          refresh();
        }}
      />
      <ReceiveMaterialDialog
        open={receiveOpen}
        onOpenChange={setReceiveOpen}
        item={item}
        locations={locations}
        onCreated={() => {
          setReceiveOpen(false);
          refresh();
        }}
      />
      <TransferMaterialDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        item={item}
        stock={item.stock}
        locations={locations}
        onCreated={() => {
          setTransferOpen(false);
          refresh();
        }}
      />
      <TransactionDetailSheet
        transactionId={detailTxnId}
        onOpenChange={(o) => {
          if (!o) setDetailTxnId(null);
        }}
      />
    </div>
  );
}

function LedgerRow({ t, onClick }: { t: ApiItemLedgerEntry; onClick: () => void }) {
  const isReceipt = t.transaction_type === 'RECEIPT';
  const isTransfer = t.transaction_type === 'TRANSFER';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-border bg-bg-elev px-4 py-3 transition-colors hover:border-accent/50 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={transactionTypeTone(t.transaction_type)}>
            {transactionTypeLabel(t.transaction_type)}
          </Badge>
          <span className="text-sm font-semibold tabular-nums">
            {isReceipt ? '+' : ''}
            {toNum(t.quantity).toLocaleString()}{' '}
            <span className="text-xs font-normal text-text-3">{t.unit_of_measure}</span>
          </span>
          <span className="text-xs text-text-3">{relativeTime(t.transaction_date)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-2">
          {isReceipt ? (
            <span className="inline-flex items-center gap-1">
              <ArrowDownToLine size={11} className="text-text-3" /> {t.to_location_name ?? '—'}
            </span>
          ) : isTransfer ? (
            <span className="inline-flex items-center gap-1">
              {t.from_location_name ?? '—'} <ArrowRight size={11} className="text-text-3" />{' '}
              {t.to_location_name ?? '—'}
            </span>
          ) : null}
          {t.lot_numbers.length > 0 && (
            <span className="text-text-3">
              · {t.lot_numbers.length > 1 ? 'Lots' : 'Lot'}{' '}
              <span className="font-mono">{t.lot_numbers.join(', ')}</span>
            </span>
          )}
        </div>
        {(t.reference_no || t.notes) && (
          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-text-3">
            {t.reference_no ? <span>Ref {t.reference_no}</span> : null}
            {t.notes ? <span className="italic">{t.notes}</span> : null}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right text-xs text-text-3">{t.created_by_name ?? '—'}</div>
    </div>
  );
}

function Metric({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-elev px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-text-3">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">
        {value}
        {suffix && <span className="ml-1 text-xs font-normal text-text-3">{suffix}</span>}
      </div>
    </div>
  );
}

function ExpiryPill({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-xs text-text-3">No expiry</span>;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return <span className="text-xs text-text-3">No expiry</span>;
  const days = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return <Badge tone="danger">Expired</Badge>;
  if (days <= 30) return <Badge tone="warning">Expires in {days}d</Badge>;
  return <span className="text-xs text-text-3">Exp {d.toLocaleDateString()}</span>;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const day = 86_400_000;
  if (diff < day) return 'today';
  const days = Math.floor(diff / day);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString();
}
