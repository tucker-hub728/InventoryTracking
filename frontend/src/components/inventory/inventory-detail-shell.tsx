'use client';

import * as React from 'react';
import Link from 'next/link';
import { notFound, usePathname, useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Pencil } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { ItemEditDialog } from './item-edit-dialog';
import { useInventoryStore } from '@/stores/inventory.store';
import { usePermission } from '@/hooks/use-permission';
import { cn, formatNumber } from '@/lib/utils';
import { movementsApi, type ApiMovement } from '@/lib/api/movements';
import { isBuiltTier } from '@/lib/api/tiers';
import { apiMovementsToLedgerEntries } from '@/lib/api/movements-adapter';
// bomApi / forecastApi are used only by the hidden forecast-demand fetch:
// import { bomApi } from '@/lib/api/bom';
// import { forecastApi } from '@/lib/api/forecast';
import { ApiError } from '@/lib/api/client';
import type { InventoryItem, LedgerEntry } from '@/types/inventory';

import { InventoryDetailProvider } from './inventory-detail-context';

// Purchased items are *received into stock* — they get the ledger, the
// "used in" (Products) view, forecast impact, and audit.
const PURCHASED_TABS = [
  { seg: 'ledger', label: 'Unit Ledger' },
  { seg: 'audit', label: 'Audit History' },
] as const;

// Product (built) items are *assembled from a BOM* — no stock ledger/snapshot.
// They get the multi-level structure (hierarchy) and the BOM editor.
// (Forecast + Audit for Products are deferred.)
const PRODUCT_TABS = [
  { seg: 'structure', label: 'Structure' },
  { seg: 'bom', label: 'BOM' },
] as const;

/**
 * Shared chrome for an inventory item's detail routes
 * (``/inventory/[id]/{ledger,products,forecast,audit}``). Loads the item +
 * ledger, renders the header (with movement / edit actions + dialogs), the
 * Snapshot + Ledger-totals sidebar, and the tab-link bar. The active route
 * segment renders as ``children`` and reads the item/ledger from context.
 */
export function InventoryDetailShell({
  itemNumber,
  children,
}: {
  itemNumber: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const fetchOne = useInventoryStore((s) => s.fetchOne);
  const canSign = usePermission('inventory', 'sign');
  const canCreate = usePermission('inventory', 'create');
  // Used only by the hidden forecast-demand fetch below:
  // const currentYear = React.useMemo(() => new Date().getFullYear(), []);

  const [item, setItem] = React.useState<InventoryItem | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);

  const [ledgerRows, setLedgerRows] = React.useState<ApiMovement[]>([]);
  const [ledgerTotal, setLedgerTotal] = React.useState(0);
  const [ledgerLoading, setLedgerLoading] = React.useState(false);
  const [ledgerError, setLedgerError] = React.useState<string | null>(null);

  // Forecast demand for the item this year — hidden along with its Snapshot row:
  // const [demand, setDemand] = React.useState<number | null>(null);

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

  // Per-item ledger (keyed on the UUID).
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

  // Forecast demand = Σ over the items that consume this one (where-used) of
  // (qty_per_unit × that parent's forecast runs this year). Temporarily hidden
  // along with the "Forecast demand" / "Projected shortfall" Snapshot rows it
  // fed — kept commented rather than left running so we don't pay for the
  // where-used + forecast round-trips on every item page load. Restore this,
  // the `demand` state, `currentYear`, the `shortfall` calc and both Snapshot
  // rows together.
  //
  // React.useEffect(() => {
  //   if (!item || isBuiltTier(item.tierType)) return;
  //   const ctrl = new AbortController();
  //   setDemand(null);
  //   Promise.all([
  //     bomApi.whereUsed(item.uuid, { signal: ctrl.signal }),
  //     forecastApi.list({ year: currentYear }, { signal: ctrl.signal }),
  //   ])
  //     .then(([using, entries]) => {
  //       if (ctrl.signal.aborted) return;
  //       const total = using.reduce((sum, p) => {
  //         const perRun = Number(p.qty_per_unit ?? 0);
  //         const runs = entries
  //           .filter((e) => e.productId === p.parent_item_id)
  //           .reduce((r, e) => r + e.runs, 0);
  //         return sum + perRun * runs;
  //       }, 0);
  //       setDemand(total);
  //     })
  //     .catch(() => {
  //       // Forecast not available yet — keep the Snapshot rows as "—".
  //     });
  //   return () => ctrl.abort();
  // }, [item, currentYear]);

  const ledgerEntries: LedgerEntry[] = React.useMemo(
    () => (item ? apiMovementsToLedgerEntries(ledgerRows, item.qty) : []),
    [ledgerRows, item],
  );

  const refresh = React.useCallback(() => {
    void load();
  }, [load]);

  // Kind-aware tabs. The server-side index redirect can't know the item kind,
  // so if we land on a segment that doesn't belong to this item's kind
  // (e.g. a Product on /ledger, or a Purchased item on /structure), bounce to
  // the kind's first tab.
  const built = isBuiltTier(item?.tierType);
  const tabs = built ? PRODUCT_TABS : PURCHASED_TABS;
  React.useEffect(() => {
    if (!item) return;
    const seg = pathname.split('/').pop();
    const valid = (built ? PRODUCT_TABS : PURCHASED_TABS).map((t) => t.seg) as string[];
    if (seg && !valid.includes(seg)) {
      router.replace(`/inventory/${item.id}/${valid[0]}`);
    }
  }, [item, built, pathname, router]);

  // ── Loading / error shells ───────────────────────────────────────────
  if (loading && item === null) {
    return (
      <>
        <FallbackHeader itemNumber={itemNumber} />
        <div className="flex items-center gap-2 px-6 py-10 text-sm text-text-2 sm:px-8">
          <Loader2 size={14} className="animate-spin" /> Loading {itemNumber}…
        </div>
      </>
    );
  }
  if (loadError && item === null) {
    return (
      <>
        <FallbackHeader itemNumber={itemNumber} />
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
  if (!item) return null;

  const activeSeg = pathname.split('/').pop();
  // Forecast shortfall (against *available* stock, date-expired excluded) —
  // hidden along with its Snapshot row:
  // const shortfall = demand != null ? Math.max(0, demand - item.qtyAvailable) : null;
  // Expired = physically on hand but not available; shown for visibility.
  const expiredQty = Math.max(0, item.qty - item.qtyAvailable);

  return (
    <>
      <PageHeader
        title={item.desc}
        crumbs={[{ label: 'Inventory', href: '/inventory' }, { label: item.id }]}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-accent">{item.id}</span>
            <span aria-hidden>·</span>
            <Badge tone={(item.tierTone as never) ?? 'neutral'} dot>
              {item.tierName}
            </Badge>
            {!built && (
              <>
                <span aria-hidden>·</span>
                <span>{item.supplier || '— No supplier —'}</span>
                <span aria-hidden>·</span>
                <StatusBadge status={item.status} />
              </>
            )}
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
          </>
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <div className={cn('grid gap-5', !built && 'lg:grid-cols-[280px_1fr]')}>
          {!built && (
          <aside className="space-y-3">
            <Card>
              <CardHeader>
                <CardTitle>Snapshot</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <KV label="Available" value={formatNumber(item.qtyAvailable)} mono />
                <KV
                  label="On hand"
                  value={
                    expiredQty > 0
                      ? `${formatNumber(item.qty)} (${formatNumber(expiredQty)} expired)`
                      : formatNumber(item.qty)
                  }
                  mono
                />
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
                {/*
                  "Forecast demand" / "Projected shortfall" — temporarily
                  hidden. The demand fetch that fed them is commented out above
                  too; restore both together from git history when forecasting
                  is wired up. (The Forecast module is still marked WIP in the
                  sidebar.)
                */}
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
          )}

          <Card className="min-w-0 overflow-hidden">
            <div className="border-b border-border px-4">
              <nav
                className="inline-flex items-center justify-start gap-1"
                aria-label="Item sections"
              >
                {tabs.map((t) => {
                  const active = activeSeg === t.seg;
                  return (
                    <Link
                      key={t.seg}
                      href={`/inventory/${item.id}/${t.seg}`}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        '-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3.5 py-2.5 text-sm font-normal text-text-2 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                        active && 'border-text font-medium text-text',
                      )}
                    >
                      {t.label}
                    </Link>
                  );
                })}
              </nav>
            </div>
            <InventoryDetailProvider
              value={{
                item,
                refresh,
                ledger: {
                  entries: ledgerEntries,
                  loading: ledgerLoading,
                  error: ledgerError,
                  total: ledgerTotal,
                },
                onReverseRequest: undefined,
                canSign,
              }}
            >
              {children}
            </InventoryDetailProvider>
          </Card>
        </div>
      </div>

      <ItemEditDialog
        open={editing}
        onOpenChange={setEditing}
        itemId={item.uuid}
        onUpdated={refresh}
      />
    </>
  );
}

function FallbackHeader({ itemNumber }: { itemNumber: string }) {
  return (
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
  );
}

function KV({
  label,
  value,
  mono,
  valueClassName,
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-text-3">{label}</dt>
      <dd
        className={cn(
          mono ? 'font-mono text-sm font-medium' : 'text-sm font-medium',
          valueClassName,
        )}
      >
        {value}
      </dd>
    </div>
  );
}
