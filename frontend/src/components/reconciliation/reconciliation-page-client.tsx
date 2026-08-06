'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight, FlaskConical, Plus, Search } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { NumberedPagination } from '@/components/ui/numbered-pagination';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LocationLink } from '@/components/locations/location-link';
import { usePermission } from '@/hooks/use-permission';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import {
  KIT_STATUS_LABEL,
  KIT_STATUSES,
  kitsApi,
  type ApiKitListItem,
  type KitStatus,
} from '@/lib/api/kits';

import { NewKitDialog } from './new-kit-dialog';
import { ItemCell, KitStatusBadge, RuleNote, formatDate } from './recon-bits';

type Filter = KitStatus | 'all';
// 'issued' is a transient state (a kit moves straight to In Production once
// material is issued), so it's omitted from the filter options.
const FILTERS: Filter[] = ['all', ...KIT_STATUSES.filter((s) => s !== 'issued')];

// One column, but a kit can produce SEVERAL batches (KIT-007 incremental
// production) and each names its own destination — a single batch can even
// split across more than one. ``kits.output_location_node_id`` keeps only the
// most recent, so the old imperative header, "Stock the output to", read as a
// standing instruction for a value that quietly changes underneath it. The
// close-out FORM keeps that wording, where it really is an instruction.
const OUTPUT_COL_LABEL = 'Last output location';
const OUTPUT_COL_HINT =
  'Where the most recent batch was stocked. A kit can produce several batches, each to its own location.';

export function ReconciliationPageClient() {
  const canCreate = usePermission('inventory', 'create');

  const [kits, setKits] = React.useState<ApiKitListItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<Filter>('all');
  const [query, setQuery] = React.useState('');
  // Debounced search term — the request fires off this, not every keystroke.
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(15);
  const [creating, setCreating] = React.useState(false);

  // Debounce the search box so typing doesn't fire a request per character.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Any filter/search/page-size change returns to page 1 — otherwise you can be
  // stranded on a page that no longer exists in the new result set.
  React.useEffect(() => {
    setPage(1);
  }, [debouncedQuery, filter, pageSize]);

  // Server-side fetch: status, search, and the page window all go to the API,
  // and we page off the server's `total` (not a client slice).
  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await kitsApi.list(
          {
            status: filter === 'all' ? undefined : filter,
            q: debouncedQuery || undefined,
            limit: pageSize,
            offset: (page - 1) * pageSize,
          },
          { signal },
        );
        setKits(res.items);
        setTotal(res.total);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load kits.');
      } finally {
        setLoading(false);
      }
    },
    [filter, debouncedQuery, page, pageSize],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const startIdx = (page - 1) * pageSize;

  // If the data shrank under us (e.g. a kit was closed elsewhere) and left the
  // current page past the end, step back to the last real page.
  React.useEffect(() => {
    if (!loading && total > 0 && page > pageCount) setPage(pageCount);
  }, [loading, total, page, pageCount]);

  return (
    <>
      <PageHeader
        title="Kitting"
        subtitle="Gather material for a build, issue it to production, then reconcile what was actually used and back-flush the rest."
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> New kit
            </Button>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="w-full min-w-[12rem] max-w-xs">
            <Input
              icon={Search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search kit #, item, description…"
              aria-label="Search kits"
            />
          </div>
          <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
            <SelectTrigger className="w-48" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === 'all' ? 'All statuses' : KIT_STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Card className="p-4">
          {loadError ? (
            <EmptyState
              title="Couldn't load kits"
              hint={loadError}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          ) : loading && kits.length === 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                    <th className="px-3 py-2 font-medium">Kit</th>
                    <th className="px-3 py-2 font-medium">Building</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Built vs target</th>
                    <th className="px-3 py-2 text-right font-medium">Scrapped</th>
                    <th className="px-3 py-2 font-medium">Production location</th>
                    <th className="px-3 py-2 font-medium" title={OUTPUT_COL_HINT}>
                      {OUTPUT_COL_LABEL}
                    </th>
                    <th className="px-3 py-2 font-medium">Opened</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-b border-border/60">
                      <td className="px-3 py-3"><Skeleton className="h-3.5 w-16" /></td>
                      <td className="px-3 py-3"><Skeleton className="h-3.5 w-28" /></td>
                      <td className="px-3 py-3"><Skeleton className="h-5 w-24 rounded-full" /></td>
                      <td className="px-3 py-3"><Skeleton className="h-3.5 w-20" /></td>
                      <td className="px-3 py-3"><Skeleton className="ml-auto h-3.5 w-8" /></td>
                      <td className="px-3 py-3"><Skeleton className="h-3.5 w-32" /></td>
                      <td className="px-3 py-3"><Skeleton className="h-3.5 w-32" /></td>
                      <td className="px-3 py-3"><Skeleton className="h-3.5 w-16" /></td>
                      <td className="px-3 py-3"><Skeleton className="ml-auto h-4 w-4" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !loading && total === 0 ? (
            <EmptyState
              icon={FlaskConical}
              title={filter === 'all' ? 'No kits yet' : 'No kits here'}
              hint={
                filter === 'all'
                  ? 'Open a kit to start gathering material for a build.'
                  : `No kits are ${KIT_STATUS_LABEL[filter as KitStatus].toLowerCase()}.`
              }
              action={
                canCreate ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus size={14} /> New kit
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                    <th className="px-3 py-2 font-medium">Kit</th>
                    <th className="px-3 py-2 font-medium">Building</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Built vs target</th>
                    <th className="px-3 py-2 text-right font-medium">Scrapped</th>
                    <th className="px-3 py-2 font-medium">Production location</th>
                    <th className="px-3 py-2 font-medium" title={OUTPUT_COL_HINT}>
                      {OUTPUT_COL_LABEL}
                    </th>
                    <th className="px-3 py-2 font-medium">Opened</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {kits.map((kit) => (
                    <tr
                      key={kit.id}
                      className="border-b border-border/60 transition-colors hover:bg-surface"
                    >
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/reconciliation/${kit.id}`}
                          className="rounded-sm font-mono text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          {kit.kit_number}
                        </Link>
                      </td>
                      <td className="max-w-[280px] px-3 py-2.5">
                        <ItemCell itemNumber={kit.item_number} description={kit.description} itemId={kit.item_id} />
                      </td>
                      <td className="px-3 py-2.5">
                        <KitStatusBadge status={kit.status} />
                      </td>
                      <td className="px-3 py-2.5">
                        <OutputCell target={kit.target_qty} good={kit.good_qty} />
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">
                        {kit.scrap_qty == null ? (
                          <span className="text-text-3">—</span>
                        ) : kit.scrap_qty > 0 ? (
                          <span className="font-medium text-danger">{kit.scrap_qty}</span>
                        ) : (
                          <span className="text-text-3">0</span>
                        )}
                      </td>
                      <td className="max-w-[200px] truncate px-3 py-2.5 text-xs text-text-2">
                        {/* ``kitStatus`` so a production floor opens on the tab
                            that actually holds this kit — a closed kit is not
                            on the In-production tab. */}
                        <LocationLink
                          nodeId={kit.production_location_node_id}
                          name={kit.production_location}
                          path={kit.production_location}
                          kitStatus={kit.status}
                        />
                      </td>
                      <td className="max-w-[200px] truncate px-3 py-2.5 text-xs text-text-2">
                        <LocationLink
                          nodeId={kit.output_location_node_id}
                          name={kit.output_location}
                          path={kit.output_location}
                        />
                      </td>
                      <td className="px-3 py-2.5 text-xs text-text-3">
                        {formatDate(kit.created_at)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Button variant="ghost" size="icon-sm" asChild>
                          <Link href={`/reconciliation/${kit.id}`} aria-label={`Open ${kit.kit_number}`}>
                            <ChevronRight size={14} />
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loadError && total > 0 && (
            <div className="border-t border-border px-1 pt-3">
              <NumberedPagination
                page={page}
                pageCount={pageCount}
                pageSize={pageSize}
                total={total}
                startIdx={startIdx}
                rowsOnPage={kits.length}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                noun="kit"
              />
            </div>
          )}
        </Card>

        <div className="mt-3">
          <RuleNote>
            A kit moves Draft → Issued → In Production → Closed. Issuing decrements the source
            location straight away, so kitted material stops counting as on hand. Nothing is bound to
            a production lot at kitting time, which is why a draft kit can always be cancelled with
            nothing stranded.
          </RuleNote>
        </div>
      </div>

      <NewKitDialog
        open={creating}
        onOpenChange={setCreating}
        // Refresh the list for when the operator navigates back; the dialog
        // handles the success toast and routes straight to the new kit.
        onCreated={() => void load()}
      />
    </>
  );
}

/**
 * Built-vs-target at a glance: `built / target` with a mini bar (green fill =
 * good units built, a tick at the target). Until a kit closes nothing is built,
 * so it reads `— / target` — the plan stays visible. Scrap is intentionally not
 * shown here (client 2026-07-22, Task 1).
 */
function OutputCell({ target, good }: { target: number; good: number | null }) {
  const g = good ?? 0;
  // The bar's full width is whichever is larger — target or what was actually
  // built — so an overbuild pushes the target tick left of the end.
  const track = Math.max(target, g, 1);
  const gPct = (g / track) * 100;
  const targetPct = Math.min(100, (target / track) * 100);
  const met = good !== null && g >= target;

  return (
    <div className="w-32">
      <div className="font-mono text-xs tabular-nums">
        {good === null ? (
          <span className="text-text-3">—</span>
        ) : (
          <span className={cn('font-semibold', met ? 'text-success' : 'text-warning')}>{g}</span>
        )}
        <span className="text-text-3"> / {target}</span>
        {good !== null && g < target && (
          <span className="ml-1 text-[10px] font-medium text-warning">{g - target}</span>
        )}
      </div>
      <div
        className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface"
        title={`${g} built · ${target} target`}
      >
        {g > 0 && (
          <div
            className={cn('absolute inset-y-0 left-0', met ? 'bg-success' : 'bg-accent')}
            style={{ width: `${gPct}%` }}
          />
        )}
        <div
          className="absolute inset-y-0 w-px bg-text-2/70"
          style={{ left: `calc(${targetPct}% - 0.5px)` }}
          aria-hidden
        />
      </div>
    </div>
  );
}
