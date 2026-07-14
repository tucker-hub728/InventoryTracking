'use client';

import * as React from 'react';
import { Boxes, Search, Warehouse as WarehouseIcon } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { NodeContentsSheet } from '@/components/locations/node-contents-sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import { locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';

/** Short shelf label (the letter), from "Shelf A" / "WH1-A". */
function shelfLabel(shelf: NodeTree): string {
  const fromName = shelf.name.trim().split(/\s+/).pop();
  if (fromName && fromName.length <= 2) return fromName;
  return shelf.code.split('-').pop() ?? shelf.name;
}

export function WarehouseClient() {
  const canTransfer = usePermission('inventory', 'sign');
  const [warehouse, setWarehouse] = React.useState<NodeTree | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<NodeTree | null>(null);

  const reload = React.useCallback(async (signal?: AbortSignal) => {
    try {
      const tree = await locationNodesApi.warehouseTree({ signal });
      setWarehouse(tree[0] ?? null);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load warehouse.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  const shelves = React.useMemo(() => warehouse?.children ?? [], [warehouse]);
  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    if (!q) return shelves;
    return shelves.filter(
      (s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q),
    );
  }, [shelves, q]);

  const stats = React.useMemo(() => {
    const occupied = shelves.filter((s) => s.active_allocation_count > 0).length;
    const units = shelves.reduce((sum, s) => sum + s.active_allocation_count, 0);
    return { occupied, units };
  }, [shelves]);

  return (
    <>
      <PageHeader
        title="Warehouse"
        subtitle={`${warehouse?.name ?? 'Warehouse'} · shelves A–Z`}
      />

      <div className="px-6 py-5 sm:px-8">
        {loadError ? (
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title="Couldn't load warehouse"
              hint={loadError}
              action={
                <Button onClick={() => window.location.reload()}>Retry</Button>
              }
            />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat
                label="Shelves"
                value={loading ? '—' : String(shelves.length)}
                icon={<WarehouseIcon size={15} />}
              />
              <Stat
                label="Occupied"
                value={loading ? '—' : String(stats.occupied)}
                sub={`of ${shelves.length} shelves`}
                icon={<Boxes size={15} />}
              />
              <Stat
                label="Units on hand"
                value={loading ? '—' : stats.units.toLocaleString()}
                sub="across all shelves"
              />
            </div>

            <div className="mt-5 flex items-center justify-between gap-3">
              <div className="max-w-xs flex-1">
                <Input
                  icon={Search}
                  placeholder="Search shelf…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search shelves"
                />
              </div>
              <p className="hidden text-xs text-text-3 sm:block">
                Free placement — units are placed on a shelf from Receipt Admin.
              </p>
            </div>

            {loading ? (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                {Array.from({ length: 12 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 rounded-lg" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="mt-4 rounded-lg border border-border bg-bg-elev">
                <EmptyState
                  title={q ? 'No shelves match' : 'No shelves yet'}
                  hint={q ? 'Try a different search.' : 'Seed the warehouse shelves.'}
                />
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                {filtered.map((shelf) => {
                  const occupied = shelf.active_allocation_count > 0;
                  return (
                    <button
                      key={shelf.id}
                      type="button"
                      onClick={() => setSelected(shelf)}
                      className={cn(
                        'flex flex-col gap-3 rounded-lg border border-border bg-bg-elev p-4 text-left transition-colors',
                        'hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                        !occupied && 'opacity-90',
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="grid size-10 place-items-center rounded-md bg-surface-2 font-mono text-lg font-semibold text-text">
                          {shelfLabel(shelf)}
                        </div>
                        {occupied ? (
                          <Badge tone="neutral">{shelf.active_allocation_count} units</Badge>
                        ) : (
                          <span className="text-[11px] font-medium uppercase tracking-wide text-text-3">
                            Empty
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-text-2">{shelf.name}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <NodeContentsSheet
        open={Boolean(selected)}
        onOpenChange={(o) => !o && setSelected(null)}
        node={selected}
        pathLabel={`${warehouse?.name ?? 'Warehouse'} › ${selected?.name ?? ''}`}
        badges={
          <>
            <Badge tone="accent">Warehouse</Badge>
            <Badge tone="neutral">Free placement</Badge>
          </>
        }
        canTransfer={canTransfer}
        onChanged={() => void reload()}
      />
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-elev p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-text-3">
        {icon}
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight text-text">{value}</div>
      {sub && <div className="text-xs text-text-3">{sub}</div>}
    </div>
  );
}

