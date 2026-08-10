'use client';

import * as React from 'react';
import Link from 'next/link';
import { notFound, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowLeftRight, Loader2, PackageOpen, Pencil, Truck } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { TransferDialog } from '@/components/locations/transfer-dialog';
import { IssueToKanbanDialog } from '@/components/inventory/issue-to-kanban-dialog';
import { ItemEditDialog } from './item-edit-dialog';
import { ShipToCustomerDialog } from './ship-to-customer-dialog';
import { useInventoryStore } from '@/stores/inventory.store';
import { usePermission } from '@/hooks/use-permission';
import { cn, formatNumber, isUuid } from '@/lib/utils';
import { movementsApi, type ApiMovement } from '@/lib/api/movements';
import { isBuiltTier } from '@/lib/api/tiers';
import { FINISHED_GOOD_TIER, RAW_MATERIAL_TIER, SUB_ASSEMBLY_TIER } from '@/config/tiers';
import { apiMovementsToLedgerEntries } from '@/lib/api/movements-adapter';
// bomApi / forecastApi are used only by the hidden forecast-demand fetch:
// import { bomApi } from '@/lib/api/bom';
// import { forecastApi } from '@/lib/api/forecast';
import { ApiError } from '@/lib/api/client';
import type { InventoryItem, LedgerEntry } from '@/types/inventory';

import { InventoryDetailProvider } from './inventory-detail-context';

const TIER_CFGS = [RAW_MATERIAL_TIER, SUB_ASSEMBLY_TIER, FINISHED_GOOD_TIER];

/** Breadcrumb for an item's tier — e.g. `Raw Materials` linking to
 *  `/inventory/cr`. Null when the tier is unknown (the crumb is then omitted). */
function tierCrumb(tierType: string | null | undefined) {
  const cfg = TIER_CFGS.find((c) => c.type === tierType);
  return cfg ? { label: cfg.title, href: `/inventory/${cfg.prefix.toLowerCase()}` } : null;
}

interface DetailTab {
  seg: string;
  label: string;
}

// "Stock by location" sits second on every tier. The Unit Ledger says what
// MOVED; this says where the item IS right now — which REQ-2026-07-01-INV-007
// requires of the drill-down, and which the transfer control needs in front of
// the operator before they choose a source (REQ-2026-07-15-TRX-001).
const STOCK_TAB: DetailTab = { seg: 'stock', label: 'Stock by location' };

// Raw materials are *received into stock* — they get the ledger and audit.
const RAW_TABS: readonly DetailTab[] = [
  { seg: 'ledger', label: 'Unit Ledger' },
  STOCK_TAB,
  { seg: 'audit', label: 'Audit History' },
];

// …plus "Used in" (the where-used view) when the material can actually appear
// in a BOM. Consumables never can — Transaction Spec §4.3: "Consumables are
// not tracked directly against an FG or AY BOM" — so for them the tab would be
// permanently empty and is omitted rather than shown blank.
const RAW_TABS_WITH_USED_IN: readonly DetailTab[] = [
  { seg: 'ledger', label: 'Unit Ledger' },
  STOCK_TAB,
  { seg: 'products', label: 'Used in' },
  { seg: 'audit', label: 'Audit History' },
];

// Built (AY/FG) items are assembled from a BOM — they get the multi-level
// structure and the BOM editor. Since kitting landed they also hold real
// stock (a close-out posts a `production_output` into a storage location, and
// a sub-assembly can be kitted into a parent), so they get the Unit Ledger
// too: REQ-2026-07-01-INV requires that "drilling into a finished good shall
// reveal its storage location(s)".
// Tab order follows the raw-material tabs for consistency (client 2026-07-24):
// Unit Ledger first, Audit History last. AUD-001 requires kitting/reconciliation
// events viewable per item, so built items now get the Audit History tab.
const PRODUCT_TABS: readonly DetailTab[] = [
  { seg: 'ledger', label: 'Unit Ledger' },
  STOCK_TAB,
  { seg: 'bom', label: 'BOM' },
  { seg: 'structure', label: 'Structure' },
  { seg: 'audit', label: 'Audit History' },
];

// …plus "Used in" for a sub-assembly (AY), which can be a component of an FG's
// BOM. A finished good is top-level and never appears on the left of a BOM
// rule (Transaction Spec §1.1), so its "Used in" would always be empty and the
// tab is omitted.
const PRODUCT_TABS_WITH_USED_IN: readonly DetailTab[] = [
  { seg: 'ledger', label: 'Unit Ledger' },
  STOCK_TAB,
  { seg: 'bom', label: 'BOM' },
  { seg: 'structure', label: 'Structure' },
  { seg: 'products', label: 'Used in' },
  { seg: 'audit', label: 'Audit History' },
];

/** Tabs for an item: built tiers get the BOM views (a sub-assembly also gets
 *  "Used in"); a raw material gets the ledger, plus "Used in" unless it's a
 *  consumable (never in a BOM). */
function tabsForItem(item: InventoryItem | null): readonly DetailTab[] {
  if (!item) return RAW_TABS;
  if (isBuiltTier(item.tierType)) {
    return item.tierType === 'finished_good' ? PRODUCT_TABS : PRODUCT_TABS_WITH_USED_IN;
  }
  return item.isConsumable ? RAW_TABS : RAW_TABS_WITH_USED_IN;
}

/**
 * Shared chrome for an inventory item's detail routes
 * (``/inventory/[id]/{ledger,products,forecast,audit}``). Loads the item +
 * ledger, renders the header (with movement / edit actions + dialogs), the
 * Snapshot + Ledger-totals sidebar, and the tab-link bar. The active route
 * segment renders as ``children`` and reads the item/ledger from context.
 */
export function InventoryDetailShell({
  itemKey,
  children,
}: {
  /** The ``[id]`` route segment: the item's stable UUID, or — for a legacy /
   *  bookmarked link — its human-readable number. Either resolves. */
  itemKey: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const fetchOne = useInventoryStore((s) => s.fetchOne);
  const canSign = usePermission('inventory', 'sign');
  const canCreate = usePermission('inventory', 'create');
  // Used only by the hidden forecast-demand fetch below:
  // const currentYear = React.useMemo(() => new Date().getFullYear(), []);

  const [item, setItem] = React.useState<InventoryItem | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [shipping, setShipping] = React.useState(false);
  const [transferring, setTransferring] = React.useState(false);
  const [issuing, setIssuing] = React.useState(false);

  // Land on a tab that has scrolled out of the strip — say Audit History,
  // reached from a bookmark — and nothing on screen says which one you are on.
  // Bring it into view instead of leaving the bar parked at the left.
  const activeTabRef = React.useRef<HTMLAnchorElement>(null);
  React.useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);

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
        const row = await fetchOne(itemKey, { signal });
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
    [fetchOne, itemKey],
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

  // Built items have no stock ledger, so no Snapshot sidebar / on-hand chips.
  const built = isBuiltTier(item?.tierType);

  // Canonical URL + tier-aware tabs, resolved together so we never fire two
  // competing redirects.
  //
  // * The URL key is the item's stable UUID. A legacy/bookmarked link carrying
  //   the human number still resolves (see ``fetchOne``), and we rewrite it to
  //   the UUID form — the number is derived from the prefix, so it changes
  //   whenever a prefix is renamed and can't be a durable URL key.
  // * The server-side index redirect can't know the item's tier, so a segment
  //   that doesn't belong to this item (a built item on /ledger, a raw material
  //   on /structure, a consumable on /products) bounces to its first tab.
  const tabs = React.useMemo(() => tabsForItem(item), [item]);
  React.useEffect(() => {
    if (!item) return;
    const valid = tabs.map((t) => t.seg);
    const seg = pathname.split('/').pop();
    const targetSeg = seg && valid.includes(seg) ? seg : valid[0];
    const target = `/inventory/${item.uuid}/${targetSeg}`;
    if (pathname !== target) {
      const query = searchParams.toString();
      router.replace(query ? `${target}?${query}` : target);
    }
  }, [item, tabs, pathname, router, searchParams]);

  // ── Loading / error shells ───────────────────────────────────────────
  // A UUID in the URL means nothing to a human, so fall back to a neutral
  // label until the real item (and its SKU) has loaded.
  const fallbackLabel = isUuid(itemKey) ? 'Item' : itemKey;

  if (loading && item === null) {
    return (
      <>
        <FallbackHeader label={fallbackLabel} />
        <div className="flex items-center gap-2 px-6 py-10 text-sm text-text-2 sm:px-8">
          <Loader2 size={14} className="animate-spin" /> Loading {fallbackLabel}…
        </div>
      </>
    );
  }
  if (loadError && item === null) {
    return (
      <>
        <FallbackHeader label={fallbackLabel} />
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
        crumbs={[
          ...(tierCrumb(item.tierType) ? [tierCrumb(item.tierType)!] : []),
          { label: item.id },
        ]}
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
            {/* The inventory workspace half of REQ-2026-07-15-TRX-001 (refined
                2026-07-22): transfer without first navigating to a location.
                Offered on all three tiers (client 2026-08-05) — a finished good
                moves between freezers before it ever ships. E-signed, so it
                gates on ``inventory:sign`` like the location-view control. */}
            {canSign && (
              <Button onClick={() => setTransferring(true)}>
                <ArrowLeftRight size={14} /> Transfer
              </Button>
            )}
            {/* Issue-to-Kanban is the consumable's terminal transaction
                (TRX-003 / TX Spec §4): the units leave inventory for a
                production area and are never back-flushed (07-09 TRX-004).
                Only offered on a consumable — a non-consumable raw material
                goes to production on a kit instead. E-signed. */}
            {item.isConsumable && canSign && (
              <Button variant="primary" onClick={() => setIssuing(true)}>
                <PackageOpen size={14} /> Issue to Kanban
              </Button>
            )}
            {/* Ship-to-customer is the terminal transaction for a built item —
                a finished good, or a sub-assembly sold directly (INV-004 /
                CUST-001). E-signed, so gate on ``inventory:sign``. */}
            {built && canSign && (
              <Button variant="primary" onClick={() => setShipping(true)}>
                <Truck size={14} /> Ship to customer
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
            {/* ``scroll-strip`` because the Card clips: six tabs on a
                sub-assembly outgrow a narrow card, and without a scroll
                container of its own the last one is unreachable rather than
                merely off screen. */}
            <div className="scroll-strip border-b border-border px-4">
              <nav
                className="inline-flex items-center justify-start gap-1"
                aria-label="Item sections"
              >
                {tabs.map((t) => {
                  const active = activeSeg === t.seg;
                  return (
                    <Link
                      key={t.seg}
                      ref={active ? activeTabRef : undefined}
                      href={`/inventory/${item.uuid}/${t.seg}`}
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

      <ShipToCustomerDialog
        open={shipping}
        onOpenChange={setShipping}
        item={{ uuid: item.uuid, id: item.id, desc: item.desc, tierType: item.tierType }}
        onDone={refresh}
      />

      <TransferDialog
        open={transferring}
        onOpenChange={setTransferring}
        item={{ uuid: item.uuid, id: item.id, desc: item.desc }}
        onDone={refresh}
      />

      <IssueToKanbanDialog
        open={issuing}
        onOpenChange={setIssuing}
        item={{ uuid: item.uuid, id: item.id, desc: item.desc }}
        onDone={refresh}
      />
    </>
  );
}

function FallbackHeader({ label }: { label: string }) {
  return (
    <PageHeader
      title={label}
      crumbs={[{ label }]}
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
