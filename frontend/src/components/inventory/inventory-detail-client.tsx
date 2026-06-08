'use client';

import * as React from 'react';
import Link from 'next/link';
import { notFound, useSearchParams } from 'next/navigation';
import {
  ArrowDownUp,
  ArrowLeft,
  ArrowRightLeft,
  Loader2,
  Pencil,
  Scale,
} from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { LedgerTable } from './ledger-table';
import { MovementWizard } from './movement-wizard';
import { AdjustmentDialog } from './adjustment-dialog';
import { TransferDialog } from './transfer-dialog';
import { ReverseDialog } from './reverse-dialog';
import { ItemEditDialog } from './item-edit-dialog';
import { ItemProductsTab } from '@/components/products/item-products-tab';
import { ForecastImpactTab } from './forecast-impact-tab';
import { EntityAuditTimeline } from '@/components/admin/audit/entity-audit-timeline';
import { useInventoryStore } from '@/stores/inventory.store';
import { usePermission } from '@/hooks/use-permission';
import { formatNumber } from '@/lib/utils';
import { movementsApi, type ApiMovement } from '@/lib/api/movements';
import { apiMovementsToLedgerEntries } from '@/lib/api/movements-adapter';
import { ApiError } from '@/lib/api/client';
import type { InventoryItem, LedgerEntry } from '@/types/inventory';

interface Props {
  itemNumber: string;
}

// Adjust / Transfer movement flows are hidden for now (frontend only).
// The dialogs + handlers stay wired; flip to true to re-enable the buttons.
const SHOW_ADJUST_TRANSFER = false;

// Reverse action hidden from the ledger for now. The dialog + handler stay
// wired; flip to true to re-enable the per-row Reverse button.
const SHOW_REVERSE = false;

/**
 * Inventory detail page client.
 *
 * Loads the item via the store (``fetchOne``) — components don't call the
 * API directly. While the audit + ledger modules ship, fields that depend
 * on movement history (active lot, expiry, location, ledger totals, audit
 * history) render as explicit "Awaiting…" placeholders rather than fake
 * values. Edit / Delete actions are deliberately hidden until the audit
 * module lands; without it, master-data mutations would have no trail.
 */
export function InventoryDetailClient({ itemNumber }: Props) {
  const params = useSearchParams();
  const fetchOne = useInventoryStore((s) => s.fetchOne);
  const canSign = usePermission('inventory', 'sign');

  const [item, setItem] = React.useState<InventoryItem | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [recording, setRecording] = React.useState(false);
  const [adjusting, setAdjusting] = React.useState(false);
  const [transferring, setTransferring] = React.useState(false);
  const [reverseTarget, setReverseTarget] = React.useState<LedgerEntry | null>(null);
  const [editing, setEditing] = React.useState(false);
  const canCreate = usePermission('inventory', 'create');

  // Ledger state — fetched after we know the item exists. Kept in this
  // component (not the store) because the ledger is per-page and stale
  // data shouldn't bleed across navigations.
  const [ledgerRows, setLedgerRows] = React.useState<ApiMovement[]>([]);
  const [ledgerTotal, setLedgerTotal] = React.useState(0);
  const [ledgerLoading, setLedgerLoading] = React.useState(false);
  const [ledgerError, setLedgerError] = React.useState<string | null>(null);

  // Fetch on mount / itemNumber change. ``fetchOne`` returns null for
  // 404 so we can flip into Next's notFound() route — anything else is
  // surfaced as a recoverable error with a Retry.
  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const row = await fetchOne(itemNumber, { signal });
        if (signal?.aborted) return;
        if (row === null) {
          notFound();
          return;
        }
        setItem(row);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load item.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [fetchOne, itemNumber],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Deep-link from "/inventory/:id?action=record" opens the dialog once
  // we have an item to attach the movement to.
  React.useEffect(() => {
    if (params.get('action') === 'record' && canSign && item) setRecording(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  // Fetch the per-item ledger once we know the item exists. The URL
  // key is ``item.id`` (UUID), not ``itemNumber`` — the ledger endpoint
  // takes the UUID. Caps at 500 rows for v1; pagination wiring comes
  // when the wizard ships and ledgers grow.
  React.useEffect(() => {
    if (!item) return;
    const ctrl = new AbortController();
    setLedgerLoading(true);
    setLedgerError(null);
    movementsApi
      .listForItem(item.uuid, { limit: 500 }, { signal: ctrl.signal })
      .then((resp) => {
        setLedgerRows(resp.items);
        setLedgerTotal(resp.total);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLedgerError(err instanceof ApiError ? err.message : 'Failed to load ledger.');
      })
      .finally(() => setLedgerLoading(false));
    return () => ctrl.abort();
  }, [item]);

  // Compute display entries; anchored to the live qty_on_hand so the
  // top row's balance matches the snapshot card.
  const ledgerEntries: LedgerEntry[] = React.useMemo(
    () => (item ? apiMovementsToLedgerEntries(ledgerRows, item.qty) : []),
    [ledgerRows, item],
  );

  // ── Loading / error shells ───────────────────────────────────────────

  if (loading && item === null) {
    return (
      <>
        <PageHeader
          title={itemNumber}
          crumbs={[{ label: 'Inventory', href: '/inventory' }, { label: itemNumber }]}
          actions={
            <Button variant="ghost" asChild>
              <Link href="/inventory">
                <ArrowLeft size={14} /> Back
              </Link>
            </Button>
          }
        />
        <div className="flex items-center gap-2 px-6 py-10 text-sm text-text-2 sm:px-8">
          <Loader2 size={14} className="animate-spin" /> Loading {itemNumber}…
        </div>
      </>
    );
  }

  if (loadError && item === null) {
    return (
      <>
        <PageHeader
          title={itemNumber}
          crumbs={[{ label: 'Inventory', href: '/inventory' }, { label: itemNumber }]}
          actions={
            <Button variant="ghost" asChild>
              <Link href="/inventory">
                <ArrowLeft size={14} /> Back
              </Link>
            </Button>
          }
        />
        <div className="px-6 py-5 sm:px-8">
          <Card>
            <EmptyState
              title="Couldn't load item"
              hint={loadError}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          </Card>
        </div>
      </>
    );
  }

  // From here on ``item`` is non-null. (Loading + error shells return above.)
  if (!item) return null;

  return (
    <>
      <PageHeader
        title={item.desc}
        crumbs={[{ label: 'Inventory', href: '/inventory' }, { label: item.id }]}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-accent">{item.id}</span>
            <span aria-hidden>·</span>
            <span>{item.vendor || '— No vendor —'}</span>
            <span aria-hidden>·</span>
            <span>{item.category}</span>
            <StatusBadge status={item.status} />
          </span>
        }
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link href="/inventory">
                <ArrowLeft size={14} /> Back
              </Link>
            </Button>
            {canCreate && (
              <Button onClick={() => setEditing(true)}>
                <Pencil size={14} /> Edit
              </Button>
            )}
            {canSign && (
              <>
                {SHOW_ADJUST_TRANSFER && (
                    <Button onClick={() => setAdjusting(true)}>
                      <Scale size={14} /> Adjust
                    </Button>
                )}
                <Button onClick={() => setTransferring(true)}>
                  <ArrowRightLeft size={14} /> Transfer
                </Button>
                <Button variant="primary" onClick={() => setRecording(true)}>
                  <ArrowDownUp size={14} /> Record movement
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          <aside className="space-y-3">
            <Card>
              <CardHeader>
                <CardTitle>Snapshot</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <KV label="Inventory Qty" value={formatNumber(item.qty)} mono />
                <KV
                  label="On order"
                  value={item.onOrder ? formatNumber(item.onOrder) : '—'}
                  mono
                />
                <KV
                  label="Reorder threshold"
                  value={item.threshold ? formatNumber(item.threshold) : '—'}
                  mono
                />
                <Separator />
                <KV label="Inventory $" value={`$${formatNumber(item.invValue)}`} mono />
                <KV label="On-PO $" value={`$${formatNumber(item.poValue)}`} mono />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Ledger totals</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <KV
                  label="Unit in (lifetime)"
                  value={formatNumber(
                    ledgerRows
                      .filter((m) => Number(m.qty_delta) > 0)
                      .reduce((s, m) => s + Number(m.qty_abs), 0),
                  )}
                  mono
                />
                <KV
                  label="Unit out (lifetime)"
                  value={formatNumber(
                    ledgerRows
                      .filter((m) => Number(m.qty_delta) < 0)
                      .reduce((s, m) => s + Number(m.qty_abs), 0),
                  )}
                  mono
                />
                <KV label="Entries" value={formatNumber(ledgerTotal)} mono />
              </CardContent>
            </Card>
          </aside>

          <Card className="min-w-0 overflow-hidden">
            <Tabs defaultValue="ledger" className="p-0">
              <div className="border-b border-border px-4">
                <TabsList>
                  <TabsTrigger value="ledger">Unit Ledger</TabsTrigger>
                  <TabsTrigger value="products">Products</TabsTrigger>
                  <TabsTrigger value="forecast">Forecast Impact</TabsTrigger>
                  <TabsTrigger value="audit">Audit History</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="ledger" className="m-0">
                <div className="overflow-x-auto">
                  {ledgerError ? (
                    <EmptyState title="Couldn't load ledger" hint={ledgerError} />
                  ) : ledgerLoading && ledgerRows.length === 0 ? (
                    <div className="py-10 text-center text-sm text-text-3" role="status">
                      Loading ledger…
                    </div>
                  ) : (
                    <LedgerTable
                      entries={ledgerEntries}
                      onReverseRequest={
                        SHOW_REVERSE && canSign
                          ? (entry) => setReverseTarget(entry)
                          : undefined
                      }
                    />
                  )}
                </div>
              </TabsContent>
              <TabsContent value="products" className="m-0">
                <ItemProductsTab itemId={item.uuid} />
              </TabsContent>
              <TabsContent value="forecast" className="m-0">
                <ForecastImpactTab itemId={item.uuid} onHand={item.qty} />
              </TabsContent>
              <TabsContent value="audit" className="m-0">
                <EntityAuditTimeline
                  subjectTable="app.items"
                  subjectId={item.uuid}
                />
              </TabsContent>
            </Tabs>
          </Card>
        </div>
      </div>

      <MovementWizard
        open={recording}
        onOpenChange={setRecording}
        presetItemId={item.uuid}
        onCompleted={() => void load()}
      />

      <AdjustmentDialog
        open={adjusting}
        onOpenChange={setAdjusting}
        itemId={item.uuid}
        itemNumber={item.id}
        itemDescription={item.desc}
        onCompleted={() => void load()}
      />

      <TransferDialog
        open={transferring}
        onOpenChange={setTransferring}
        presetItemId={item.uuid}
        presetItemNumber={item.id}
        onCompleted={() => void load()}
      />

      <ReverseDialog
        open={reverseTarget !== null}
        onOpenChange={(o) => {
          if (!o) setReverseTarget(null);
        }}
        entry={reverseTarget}
        onCompleted={() => void load()}
      />

      <ItemEditDialog
        open={editing}
        onOpenChange={setEditing}
        itemId={item.uuid}
        onUpdated={() => void load()}
      />
    </>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-text-3">{label}</dt>
      <dd className={mono ? 'font-mono text-sm font-medium' : 'text-sm font-medium'}>
        {value}
      </dd>
    </div>
  );
}
