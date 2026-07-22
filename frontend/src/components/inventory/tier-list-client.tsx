'use client';

import * as React from 'react';
import Link from 'next/link';
import { Plus, Search } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { useMinDuration } from '@/hooks/use-min-duration';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import { itemsApi, type ListItemsParams } from '@/lib/api/items';
import { tiersApi, isBuiltTier, type ApiTier, type TierType } from '@/lib/api/tiers';
import { apiItemToInventoryItem } from '@/lib/api/items-adapter';
import { cn } from '@/lib/utils';
import type { InventoryItem } from '@/types/inventory';

import { NewItemDialog } from './new-item-dialog';

/**
 * Per-tier list page (Raw Materials / Sub-Assemblies / Finished Goods).
 *
 * REQ-2026-07-01-INV-001 requires each of the three tiers to have its own
 * dedicated screen rather than a filter over one shared inventory list, and
 * REQ-2026-07-15-ITM-001 fixes the set at exactly three. The tiers differ only
 * in labelling and a couple of columns, so they share this client and are
 * configured by the ``TierConfig`` passed from each route.
 */
/** One filter pill in the row beside the search box. */
export interface TierFilter {
  /** Stable id — also the control's value. The first entry is the default. */
  id: string;
  label: string;
  /** Extra query params merged into the list request. Omit for "All".
   *  Filtering is server-side: the list is capped at 200 rows, so filtering
   *  in memory would quietly search only the first page. */
  params?: Pick<ListItemsParams, 'is_consumable' | 'has_bom' | 'below_reorder'>;
}

export interface TierConfig {
  /** Canonical SKU prefix for this tier (``CR`` / ``AY`` / ``FG``) — informational
   *  only; the tier is resolved by ``type`` and the real prefixes come from the
   *  tier's admin-managed ``prefixes`` list. */
  prefix: string;
  /** Tier type — the key the page resolves its tier by. */
  type: TierType;
  /** Filter pills beside the search box. Non-empty by construction — the
   *  first entry is the default ("All"). */
  filters: readonly [TierFilter, ...TierFilter[]];
  /** Page + breadcrumb title, e.g. "Sub-Assemblies". */
  title: string;
  /** Lower-case singular noun used in prose, e.g. "sub-assembly". */
  singular: string;
  /** Lower-case plural noun used in prose, e.g. "sub-assemblies". */
  plural: string;
  /** Create-button / dialog-title label, e.g. "New Sub-Assembly". */
  newLabel: string;
  /** Success-toast headline, e.g. "Sub-assembly created". */
  createdLabel: string;
  /** Detail route segment the SKU links to. Purchased items open the stock
   *  ledger; built items have no ledger tab and open their structure. */
  detailSegment: string;
}

/** Locate the page's tier by type. Exactly three tiers exist, one seeded per
 *  type (REQ-2026-07-15-ITM-001), so the type match is unambiguous; the
 *  non-seeded fallback covers a hand-created tier of the same type. */
function findTier(tiers: ApiTier[], cfg: TierConfig): ApiTier | null {
  return (
    tiers.find((c) => c.type === cfg.type && c.is_seeded) ??
    tiers.find((c) => c.type === cfg.type) ??
    null
  );
}

export function TierListClient({ config }: { config: TierConfig }) {
  const canCreate = usePermission('inventory', 'create');

  // The consumable flag is CR-only — Transaction Spec §1.1: "A CR item may be
  // designated as either a raw material or a consumable."
  const showConsumable = config.type === 'raw_material';
  // Only built tiers carry a BOM; a raw material is bought, not assembled, so
  // the column would read "None" on every row.
  const showBom = isBuiltTier(config.type);

  const [tier, setTier] = React.useState<ApiTier | null>(null);
  const [rows, setRows] = React.useState<InventoryItem[]>([]);
  // Unpaged count from the server — the row array stops at the 200 cap.
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  // False until the first successful fetch. Drives skeleton-vs-table: once
  // real rows have landed, a refetch dims them instead of blanking the page,
  // so typing in the search box doesn't flash a skeleton on every keystroke.
  const [hasLoaded, setHasLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  // Held briefly — the list returns in ~20ms locally, too fast to see.
  const showSkeleton = useMinDuration(!hasLoaded && !loadError);

  // Active filter pill. The first entry ("All") is the default; reset when the
  // page switches tier so a stale pill can't carry across.
  const [filterId, setFilterId] = React.useState(config.filters[0].id);
  React.useEffect(() => {
    setFilterId(config.filters[0].id);
  }, [config]);
  const activeFilter = config.filters.find((f) => f.id === filterId) ?? config.filters[0];

  // Search box (debounced into the fetch below).
  const [queryInput, setQueryInput] = React.useState('');
  const [query, setQuery] = React.useState('');
  React.useEffect(() => {
    const t = setTimeout(() => setQuery(queryInput.trim()), 250);
    return () => clearTimeout(t);
  }, [queryInput]);

  // Resolve the tier's tier once.
  React.useEffect(() => {
    const ctrl = new AbortController();
    tiersApi
      .list({ signal: ctrl.signal })
      .then((tiers) => {
        const found = findTier(tiers, config);
        setTier(found);
        // Without a tier there's nothing to fetch, so ``fetchRows`` bails and
        // ``loading`` would never clear — say so instead of spinning forever.
        if (!found) {
          setLoadError(`The ${config.title} tier is missing from the catalogue.`);
          setLoading(false);
        }
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load tiers.');
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [config]);

  const fetchRows = React.useCallback(
    async (signal?: AbortSignal) => {
      if (!tier) return;
      setLoading(true);
      setLoadError(null);
      try {
        const res = await itemsApi.list(
          {
            tier_id: tier.id,
            q: query || undefined,
            sort: 'item_number',
            direction: 'asc',
            limit: 200,
            ...activeFilter.params,
          },
          { signal },
        );
        setRows(res.items.map(apiItemToInventoryItem));
        setTotal(res.total);
        setHasLoaded(true);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : `Failed to load ${config.plural}.`);
      } finally {
        // Skip when this request was superseded: the replacement has already
        // set ``loading`` true, and clearing it here would drop the skeleton
        // while the new fetch is still in flight.
        if (!signal?.aborted) setLoading(false);
      }
    },
    [tier, query, activeFilter, config.plural],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void fetchRows(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchRows]);

  const newButton = (
    <Button variant="primary" onClick={() => setCreating(true)} disabled={!tier}>
      <Plus size={14} /> {config.newLabel}
    </Button>
  );

  // "Nothing here" and "nothing matched" are different messages: with a search
  // term or a non-default pill, the tier isn't empty — the filter just excluded
  // everything.
  const isNarrowed = Boolean(query) || filterId !== config.filters[0].id;

  // Shared by the skeleton and the real table so both agree on the columns.
  const tableHeader = (
    <TableHeader>
      <TableRow>
        <TableHead className="w-[160px]">SKU</TableHead>
        <TableHead>Name</TableHead>
        {showConsumable && <TableHead className="w-[130px]">Consumable</TableHead>}
        {showBom && <TableHead className="w-[110px]">BOM</TableHead>}
        <TableHead className="w-[140px]">On hand</TableHead>
        <TableHead className="w-[140px]">Stock status</TableHead>
        <TableHead className="w-[120px]">Updated</TableHead>
      </TableRow>
    </TableHeader>
  );
  // SKU, Name, On hand, Stock status, Updated + the two optional columns.
  const columnCount = 5 + (showConsumable ? 1 : 0) + (showBom ? 1 : 0);

  return (
    <>
      <PageHeader
        title={config.title}
        crumbs={[{ label: 'Inventory' }, { label: config.title }]}
        subtitle={
          loading
            ? `Loading ${config.plural}…`
            : `${total.toLocaleString()} ${total === 1 ? config.singular : config.plural}`
        }
        actions={canCreate ? newButton : undefined}
      />

      <div className="px-6 py-5 sm:px-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="w-full max-w-xs">
            <Input
              icon={Search}
              placeholder="Search SKU or name…"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              aria-label={`Search ${config.plural}`}
            />
          </div>
          {config.filters.length > 1 && (
            <SegmentedControl
              aria-label={`Filter ${config.plural}`}
              options={config.filters.map((f) => ({
                value: f.id,
                label: f.label,
              }))}
              value={filterId}
              onChange={setFilterId}
            />
          )}
        </div>

        <Card className="overflow-hidden">
          {loadError ? (
            <EmptyState
              title={`Couldn't load ${config.plural}`}
              hint={loadError}
              action={<Button onClick={() => void fetchRows()}>Retry</Button>}
            />
          ) : showSkeleton ? (
            // First load: skeleton rows inside the real table, so the columns
            // land at their final widths and nothing jumps when data arrives.
            <div className="overflow-x-auto">
              <Table className="min-w-[840px]">
                {tableHeader}
                <TableBody>
                  {Array.from({ length: 6 }).map((_, r) => (
                    <TableRow key={r}>
                      {Array.from({ length: columnCount }).map((_, c) => (
                        <TableCell key={c}>
                          <Skeleton className="h-4 w-full max-w-[110px]" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <span className="sr-only" role="status">
                Loading {config.plural}…
              </span>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              title={isNarrowed ? `No ${config.plural} match` : `No ${config.plural} yet`}
              hint={
                isNarrowed
                  ? query
                    ? 'Try a different search term or filter.'
                    : `Nothing in this tier is ${activeFilter.label.toLowerCase()}.`
                  : canCreate
                    ? `Create your first ${config.singular} to get started.`
                    : `${config.title} will appear here once added.`
              }
              action={!isNarrowed && canCreate ? newButton : undefined}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table
                className={cn(
                  'min-w-[840px] transition-opacity',
                  // Refetching (filter / search change) with rows already on
                  // screen: dim rather than blank, so the page doesn't jump.
                  loading && 'opacity-50',
                )}
              >
                {tableHeader}
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.uuid} interactive className="group">
                      <TableCell className="font-mono">
                        <Link
                          href={`/inventory/${row.uuid}/${config.detailSegment}`}
                          className="rounded-sm text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          {row.id}
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-2">{row.desc}</TableCell>
                      {showConsumable && (
                        <TableCell>
                          {row.isConsumable ? (
                            <Badge tone="accent">Yes</Badge>
                          ) : (
                            <span className="text-text-3">—</span>
                          )}
                        </TableCell>
                      )}
                      {showBom && (
                        <TableCell>
                          <Link
                            href={`/inventory/${row.uuid}/bom`}
                            className={cn(
                              'rounded-sm tabular-nums hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                              row.bomLineCount > 0 ? 'text-text' : 'text-text-3',
                            )}
                          >
                            {row.bomLineCount > 0
                              ? `${row.bomLineCount} ${row.bomLineCount === 1 ? 'item' : 'items'}`
                              : 'None'}
                          </Link>
                        </TableCell>
                      )}
                      <TableCell className="font-mono tabular-nums text-text">
                        {row.qty}
                        {row.uom ? <span className="ml-1 text-text-3">{row.uom}</span> : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="text-text-3">
                        {row.updatedAt ? new Date(row.updatedAt).toLocaleDateString() : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      </div>

      <NewItemDialog
        open={creating}
        onOpenChange={setCreating}
        lockedTier={tier}
        title={config.newLabel}
        description={tier ? `Create a new ${config.singular} in the ${tier.name} tier.` : undefined}
        submitLabel={config.newLabel.replace(/^New /, 'Create ')}
        createdLabel={config.createdLabel}
        onCreated={() => void fetchRows()}
      />
    </>
  );
}
