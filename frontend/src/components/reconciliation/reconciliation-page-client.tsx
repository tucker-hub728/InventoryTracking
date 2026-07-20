'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight, FlaskConical, Plus, RefreshCw, Search } from 'lucide-react';

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
import { toast } from '@/components/ui/sonner';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import {
  KIT_STATUS_LABEL,
  KIT_STATUSES,
  kitYield,
  kitsApi,
  type ApiKitListItem,
  type KitStatus,
} from '@/lib/api/kits';

import { NewKitDialog } from './new-kit-dialog';
import { ItemCell, KitStatusBadge, RuleNote, formatDate } from './recon-bits';

type Filter = KitStatus | 'all';
const FILTERS: Filter[] = ['all', ...KIT_STATUSES];

export function ReconciliationPageClient() {
  const canCreate = usePermission('inventory', 'create');

  const [kits, setKits] = React.useState<ApiKitListItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<Filter>('all');
  const [query, setQuery] = React.useState('');
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await kitsApi.list({ limit: 200 }, { signal });
      setKits(res.items);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load kits.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const counts = React.useMemo(() => {
    const out: Record<string, number> = { all: kits.length };
    for (const k of kits) out[k.status] = (out[k.status] ?? 0) + 1;
    return out;
  }, [kits]);
  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return kits.filter(
      (k) =>
        (filter === 'all' || k.status === filter) &&
        (!q ||
          k.kit_number.toLowerCase().includes(q) ||
          k.item_number.toLowerCase().includes(q) ||
          k.description.toLowerCase().includes(q)),
    );
  }, [kits, filter, query]);

  return (
    <>
      <PageHeader
        title="Kitting & Reconciliation"
        subtitle="Gather material for a build, issue it to production, then reconcile what was actually used and back-flush the rest."
        actions={
          <>
            <Button variant="ghost" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} /> Refresh
            </Button>
            {canCreate && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={14} /> New kit
              </Button>
            )}
          </>
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
                  {s === 'all' ? 'All statuses' : KIT_STATUS_LABEL[s]} ({counts[s] ?? 0})
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
          ) : !loading && visible.length === 0 ? (
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
                    <th className="px-3 py-2 text-right font-medium">Target</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 text-right font-medium">Lines</th>
                    <th className="px-3 py-2 text-right font-medium">Yield</th>
                    <th className="px-3 py-2 font-medium">Opened</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((kit) => {
                    const y = kitYield(kit.good_qty, kit.scrap_qty);
                    return (
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
                          <ItemCell itemNumber={kit.item_number} description={kit.description} />
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">
                          {kit.target_qty}
                        </td>
                        <td className="px-3 py-2.5">
                          <KitStatusBadge status={kit.status} />
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-text-3">
                          {kit.line_count}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {y === null ? (
                            <span className="text-xs text-text-3">—</span>
                          ) : (
                            <Badge tone={y >= 1 ? 'success' : y >= 0.8 ? 'warning' : 'danger'}>
                              {Math.round(y * 100)}%
                            </Badge>
                          )}
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
                    );
                  })}
                </tbody>
              </table>
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
        onCreated={() => {
          void load();
          toast.success('Kit opened');
        }}
      />
    </>
  );
}
