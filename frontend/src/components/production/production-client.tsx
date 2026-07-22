'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Boxes, CheckCircle2, Factory, Search, Wrench } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { KitStatusBadge } from '@/components/reconciliation/recon-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import { kitsApi, type ApiFloorKitsResponse } from '@/lib/api/kits';
import { locationNodesApi, type LocationNode } from '@/lib/api/location-nodes';

/**
 * Read-only view of the production floors and the material currently on them.
 *
 * Production floors are ``flat`` location nodes (``flat_category = 'production'``).
 * A kit MOVES its components here at issue time, so a floor's active allocations
 * are the WIP for the kits building on it (docs/modules/kitting-wip-build.md).
 * This screen just surfaces that placement — like the Warehouse view — so you
 * can see which items are on which floor. No transfers from here (client
 * 2026-07-22, Task 2): WIP moves only through the kit's own issue / close-out.
 */
export function ProductionClient() {
  const [floors, setFloors] = React.useState<LocationNode[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<LocationNode | null>(null);

  const reload = React.useCallback(async (signal?: AbortSignal) => {
    try {
      const nodes = await locationNodesApi.flat({ category: 'production', signal });
      setFloors(nodes.filter((n) => n.is_active));
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load production floors.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    if (!q) return floors;
    return floors.filter(
      (f) => f.name.toLowerCase().includes(q) || f.code.toLowerCase().includes(q),
    );
  }, [floors, q]);

  const stats = React.useMemo(() => {
    const inUse = floors.filter((f) => f.active_allocation_count > 0).length;
    const units = floors.reduce((sum, f) => sum + f.active_allocation_count, 0);
    return { inUse, units };
  }, [floors]);

  return (
    <>
      <PageHeader title="Production" subtitle="Manufacturing & lab floors · work-in-progress on the floor" />

      <div className="px-6 py-5 sm:px-8">
        {loadError ? (
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title="Couldn't load production floors"
              hint={loadError}
              action={<Button onClick={() => window.location.reload()}>Retry</Button>}
            />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Floors" value={loading ? '—' : String(floors.length)} icon={<Factory size={15} />} />
              <Stat
                label="In use"
                value={loading ? '—' : String(stats.inUse)}
                sub={`of ${floors.length} floors`}
                icon={<Boxes size={15} />}
              />
              <Stat
                label="Units on floor"
                value={loading ? '—' : stats.units.toLocaleString()}
                sub="WIP across all floors"
              />
            </div>

            <div className="mt-5 flex items-center justify-between gap-3">
              <div className="max-w-xs flex-1">
                <Input
                  icon={Search}
                  placeholder="Search floor…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search production floors"
                />
              </div>
              <p className="hidden text-xs text-text-3 sm:block">
                Material lands here when a kit is issued and leaves at close-out.
              </p>
            </div>

            {loading ? (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-28 rounded-lg" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="mt-4 rounded-lg border border-border bg-bg-elev">
                <EmptyState
                  title={q ? 'No floors match' : 'No production floors'}
                  hint={q ? 'Try a different search.' : 'Production floors are seeded with the system.'}
                />
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                {filtered.map((floor) => {
                  const busy = floor.active_allocation_count > 0;
                  return (
                    <button
                      key={floor.id}
                      type="button"
                      onClick={() => setSelected(floor)}
                      className={cn(
                        'flex flex-col gap-3 rounded-lg border border-border bg-bg-elev p-4 text-left transition-colors',
                        'hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                        !busy && 'opacity-90',
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="grid size-10 place-items-center rounded-md bg-surface-2 text-accent">
                          <Factory size={18} />
                        </div>
                        {busy ? (
                          <Badge tone="warning">{floor.active_allocation_count} WIP</Badge>
                        ) : (
                          <span className="text-[11px] font-medium uppercase tracking-wide text-text-3">
                            Idle
                          </span>
                        )}
                      </div>
                      <div className="text-sm font-medium text-text">{floor.name}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <ProductionFloorSheet floor={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </>
  );
}

/** Floor detail: the WIP on a floor grouped by the KIT it belongs to, so you can
 *  see which build each pile of material is for (client 2026-07-22). */
function ProductionFloorSheet({
  floor,
  onOpenChange,
}: {
  floor: LocationNode | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = React.useState<ApiFloorKitsResponse | null>(null);

  React.useEffect(() => {
    if (!floor) return;
    const ctrl = new AbortController();
    setData(null);
    void kitsApi
      .onFloor(floor.id, { signal: ctrl.signal })
      .then((r) => setData(r))
      .catch(() => setData({ active: [], completed: [] }));
    return () => ctrl.abort();
  }, [floor?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = data?.active ?? [];
  const completed = data?.completed ?? [];
  const wip = active.reduce((a, k) => a + k.on_floor_total, 0);

  return (
    <Sheet open={Boolean(floor)} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:w-[560px]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Factory size={16} className="text-accent" /> {floor?.name}
          </SheetTitle>
          <p className="text-xs text-text-3">
            {data === null
              ? 'Loading…'
              : `${active.length} building · ${wip} unit${wip === 1 ? '' : 's'} of WIP · ${completed.length} completed here.`}
          </p>
        </SheetHeader>
        <SheetBody className="space-y-4 px-4 py-4">
          {data === null ? (
            <p className="p-6 text-center text-xs text-text-3">Loading…</p>
          ) : active.length === 0 && completed.length === 0 ? (
            <EmptyState
              icon={Factory}
              title="Floor is idle"
              hint="Material appears here when a kit is issued to this floor."
            />
          ) : (
            <>
              {/* Live WIP */}
              <section className="space-y-2">
                <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-text-3">
                  <Wrench size={12} /> In production
                </h3>
                {active.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-text-3">
                    Nothing building here right now.
                  </p>
                ) : (
                  active.map((kit) => (
                    <div key={kit.id} className="rounded-lg border border-border bg-bg-elev">
                      <Link
                        href={`/reconciliation/${kit.id}`}
                        className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2.5 transition-colors hover:bg-surface"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-semibold text-accent">
                              {kit.kit_number}
                            </span>
                            <KitStatusBadge status={kit.status} />
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-text-3">
                            Building {kit.target_qty} ×{' '}
                            <span className="font-mono">{kit.item_number}</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge tone="warning">{kit.on_floor_total} on floor</Badge>
                          <ArrowRight size={14} className="text-text-3" />
                        </div>
                      </Link>
                      <ul className="divide-y divide-border/50">
                        {kit.lines.map((line) => (
                          <li
                            key={line.item_id}
                            className="flex items-center justify-between gap-2 px-3 py-1.5"
                          >
                            <span className="truncate font-mono text-xs text-text-2">
                              {line.item_number}
                            </span>
                            <span className="shrink-0 font-mono text-xs tabular-nums text-text">
                              {line.on_floor_qty}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </section>

              {/* Consumed by completed builds */}
              {completed.length > 0 && (
                <section className="space-y-2">
                  <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-text-3">
                    <CheckCircle2 size={12} /> Consumed here
                  </h3>
                  {completed.map((kit) => (
                    <div key={kit.id} className="rounded-lg border border-border bg-bg-elev">
                      <Link
                        href={`/reconciliation/${kit.id}`}
                        className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2.5 transition-colors hover:bg-surface"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-semibold text-accent">
                              {kit.kit_number}
                            </span>
                            <Badge tone="success">{kit.good_qty ?? 0} made</Badge>
                            {(kit.scrap_qty ?? 0) > 0 && (
                              <Badge tone="danger">{kit.scrap_qty} scrapped</Badge>
                            )}
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-text-3">
                            Built <span className="font-mono">{kit.item_number}</span>
                            {kit.closed_at && ` · ${new Date(kit.closed_at).toLocaleDateString()}`}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge tone="neutral">{kit.consumed_total} consumed</Badge>
                          <ArrowRight size={14} className="text-text-3" />
                        </div>
                      </Link>
                      <ul className="divide-y divide-border/50">
                        {kit.lines.map((line) => (
                          <li
                            key={line.item_id}
                            className="flex items-center justify-between gap-2 px-3 py-1.5"
                          >
                            <span className="truncate font-mono text-xs text-text-2">
                              {line.item_number}
                            </span>
                            <span className="shrink-0 font-mono text-xs tabular-nums text-text-3">
                              −{line.used_qty}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
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
