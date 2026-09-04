'use client';

import * as React from 'react';
import Link from 'next/link';
import { Boxes, Factory, Pencil, Plus, Search } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { DEFAULT_FLOOR_TAB } from '@/components/production/floor-tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useAuthStore, selectIsSuperAdmin } from '@/stores/auth.store';
import { ApiError } from '@/lib/api/client';
import { invalidateLocationForest } from '@/components/reconciliation/location-tree-picker';
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
  // Adding / renaming production areas is super-admin-only (client 2026-07-23):
  // new areas are added by an admin on request, not by every operator.
  const canManage = useAuthStore(selectIsSuperAdmin);
  const [floors, setFloors] = React.useState<LocationNode[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [renaming, setRenaming] = React.useState<LocationNode | null>(null);

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
      <PageHeader
        title="Production"
        subtitle="Manufacturing & lab areas · work-in-progress on the floor"
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus size={15} /> Add area
            </Button>
          ) : undefined
        }
      />

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
                    <div key={floor.id} className="group relative">
                      {/* Opens the floor's own page (client 2026-07-28) — the
                          slide-out couldn't carry a busy floor's history. */}
                      <Link
                        href={`/production/${floor.id}/${DEFAULT_FLOOR_TAB}`}
                        className={cn(
                          'flex w-full flex-col gap-3 rounded-lg border border-border bg-bg-elev p-4 text-left transition-colors',
                          'hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                          !busy && 'opacity-90',
                        )}
                      >
                        <div className="flex items-start justify-between">
                          <div className="grid size-10 place-items-center rounded-md bg-surface-2 text-accent">
                            <Factory size={18} />
                          </div>
                          {busy ? (
                            <Badge tone="warning">{floor.active_allocation_count} In Production</Badge>
                          ) : (
                            <span className="text-[11px] font-medium uppercase tracking-wide text-text-3">
                              Idle
                            </span>
                          )}
                        </div>
                        <div className="text-sm font-medium text-text">{floor.name}</div>
                      </Link>
                      {canManage && (
                        <button
                          type="button"
                          onClick={() => setRenaming(floor)}
                          aria-label={`Rename ${floor.name}`}
                          title="Rename area"
                          className={cn(
                            'absolute bottom-2 right-2 grid size-7 place-items-center rounded-md text-text-3 transition',
                            'opacity-0 hover:bg-surface-2 hover:text-text focus:outline-none',
                            'focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100',
                          )}
                        >
                          <Pencil size={13} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <AddAreaDialog
        open={adding}
        onOpenChange={setAdding}
        existingNames={floors.map((f) => f.name)}
        onCreated={() => void reload()}
      />
      <RenameAreaDialog
        area={renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        existingNames={floors.map((f) => f.name)}
        onRenamed={() => void reload()}
      />
    </>
  );
}

/** Add a new production area (admin). The server generates the code from the
 *  name; here we only collect the name and guard against an obvious duplicate. */
function AddAreaDialog({
  open,
  onOpenChange,
  existingNames,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: string[];
  onCreated: () => void;
}) {
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const trimmed = name.trim();
  const dupe = existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase());
  const canSubmit = trimmed.length > 0 && !dupe && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.createProductionArea(trimmed);
      // A kit's production-floor picker reads the cached location tree, so a new
      // area would not be offerable until the next full page load.
      invalidateLocationForest();
      onCreated();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add the area.');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add production area</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-xs text-text-3">
            A new manufacturing or lab area under Production. You can rename it later.
          </p>
          <div className="space-y-1.5">
            <label htmlFor="new-area-name" className="text-xs font-medium text-text-2">
              Area name
            </label>
            <Input
              id="new-area-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              placeholder="e.g. CR 301"
              maxLength={128}
              aria-label="Area name"
            />
            {dupe && (
              <p className="text-xs text-danger">An area with that name already exists.</p>
            )}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? 'Adding…' : 'Add area'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Rename a production area to the client's real area name. */
function RenameAreaDialog({
  area,
  onOpenChange,
  existingNames,
  onRenamed,
}: {
  area: LocationNode | null;
  onOpenChange: (open: boolean) => void;
  existingNames: string[];
  onRenamed: () => void;
}) {
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (area) {
      setName(area.name);
      setError(null);
      setBusy(false);
    }
  }, [area]);

  const trimmed = name.trim();
  const unchanged = trimmed === area?.name;
  const dupe =
    !unchanged &&
    existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase());
  const canSubmit = trimmed.length > 0 && !unchanged && !dupe && !busy;

  const submit = async () => {
    if (!canSubmit || !area) return;
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.rename(area.id, trimmed);
      onRenamed();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rename the area.');
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(area)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rename area</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="rename-area-name" className="text-xs font-medium text-text-2">
              Area name
            </label>
            <Input
              id="rename-area-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              maxLength={128}
              aria-label="Area name"
            />
            {dupe && (
              <p className="text-xs text-danger">An area with that name already exists.</p>
            )}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
