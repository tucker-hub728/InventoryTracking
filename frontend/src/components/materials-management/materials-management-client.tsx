'use client';

import * as React from 'react';
import Link from 'next/link';
import { Boxes, Pencil, Plus, Search, Snowflake, Warehouse as WarehouseIcon } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { NodeContentsSheet } from '@/components/locations/node-contents-sheet';
import { MM_TABS, mmHref } from '@/components/materials-management/mm-tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { usePermission } from '@/hooks/use-permission';
import { selectIsSuperAdmin, useAuthStore } from '@/stores/auth.store';
import { ApiError } from '@/lib/api/client';
import { locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';

/** Short shelf label (the letter), from "Shelf A" / "WH1-A". */
function shelfLabel(shelf: NodeTree): string {
  const fromName = shelf.name.trim().split(/\s+/).pop();
  if (fromName && fromName.length <= 2) return fromName;
  return shelf.code.split('-').pop() ?? shelf.name;
}

/**
 * Materials Management — the room, and everything in it (REQ-2026-07-15-LOC-005).
 *
 * The room holds two peer locations, so they are tabs rather than two sidebar
 * entries: Warehouse One's shelves, and the Cold Storage groups with their
 * equipment units. Warehouse used to be its own top-level page; LOC-005 put it
 * inside this room, so it moved in here.
 *
 * The open panel is reflected in the URL (`/materials-management/cold-storage/{id}`)
 * so a refresh or a shared link reopens the same unit — but clicking a shelf is
 * NOT a router navigation. It rewrites the address bar with
 * ``window.history.pushState`` (supported by the App Router since Next 14.1)
 * and opens the panel from local state.
 *
 * Routing on click looked correct and was not: the node id sits in a dynamic
 * route segment, and changing a dynamic segment's value changes that segment's
 * key, so React unmounts the page subtree and mounts a fresh one — even though
 * both URLs resolve to this same file. That threw away the loaded trees and
 * refetched them on every click. The id still has to live in the path for
 * refresh to work, so the route stays; only the click stops going through it.
 */
export function MaterialsManagementClient({
  tab,
  nodeId,
}: {
  /** Validated by the route file; one of MM_TABS' segments. */
  tab: string;
  /** A shelf or cold unit whose contents panel should be open on first paint
   *  (from the URL). After that the panel is driven by local state. */
  nodeId?: string;
}) {
  const canTransfer = usePermission('inventory', 'sign');
  // LOC-003 / LOC-006: only a Super Admin may add or rename shelves and Cold
  // Storage nodes. The API enforces this too — this just hides dead controls.
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);

  const [room, setRoom] = React.useState<NodeTree | null>(null);
  const [warehouse, setWarehouse] = React.useState<NodeTree | null>(null);
  const [loading, setLoading] = React.useState(true);
  // Distinct from `!loading`: proves a request actually came back with data.
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [addLocation, setAddLocation] = React.useState(false);
  const [addUnitTo, setAddUnitTo] = React.useState<NodeTree | null>(null);
  const [renaming, setRenaming] = React.useState<NodeTree | null>(null);

  // Which node's panel is open. Seeded from the URL, then owned here.
  const [openId, setOpenId] = React.useState<string | undefined>(nodeId);

  /** Open/close the panel and keep the address bar in step, without routing. */
  const setOpen = React.useCallback(
    (id: string | undefined, { replace = false } = {}) => {
      setOpenId(id);
      const url = mmHref(tab, id);
      if (typeof window === 'undefined' || window.location.pathname === url) return;
      if (replace) window.history.replaceState(null, '', url);
      else window.history.pushState(null, '', url);
    },
    [tab],
  );

  // Back/Forward move through the entries pushed above, so re-read the id from
  // the address bar rather than trusting our own state.
  React.useEffect(() => {
    const onPop = () => {
      const parts = window.location.pathname.split('/').filter(Boolean);
      // /materials-management/{tab}/{id?}
      setOpenId(parts.length >= 3 ? decodeURIComponent(parts[2]!) : undefined);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const reload = React.useCallback(async (signal?: AbortSignal) => {
    setLoadError(null);
    try {
      // Two calls because the API serves one area's node types per endpoint.
      // The room comes back from the freezer tree; the warehouse arrives as its
      // own forest root even though it now hangs under that same room.
      const [rooms, warehouses] = await Promise.all([
        locationNodesApi.freezerTree({ signal }),
        locationNodesApi.warehouseTree({ signal }),
      ]);
      setRoom(rooms[0] ?? null);
      setWarehouse(warehouses[0] ?? null);
      setLoaded(true);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(
        err instanceof ApiError ? err.message : 'Failed to load Materials Management.',
      );
    } finally {
      // An ABORTED request must not clear `loading`. A `return` inside the
      // catch above still runs this block, and React StrictMode mounts, aborts
      // and remounts in development — so clearing it here left loading=false
      // with no data, and the "unknown node" guard below then rewrote the URL
      // and closed the panel on every refresh of a deep link.
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  const coldLocations = React.useMemo(() => room?.children ?? [], [room]);
  const shelves = React.useMemo(() => warehouse?.children ?? [], [warehouse]);

  // Resolve the open node against whichever tab is showing.
  const selected = React.useMemo<{ node: NodeTree; path: string } | null>(() => {
    if (!openId) return null;
    if (tab === 'warehouse') {
      const shelf = shelves.find((s) => s.id === openId);
      return shelf
        ? { node: shelf, path: `${warehouse?.name ?? 'Warehouse'} › ${shelf.name}` }
        : null;
    }
    for (const loc of coldLocations) {
      const unit = loc.children.find((u) => u.id === openId);
      if (unit) return { node: unit, path: `${loc.name} › ${unit.name}` };
    }
    return null;
  }, [openId, tab, shelves, coldLocations, warehouse]);

  // An id that isn't in this tab (stale link, deleted node) shouldn't leave the
  // page stuck on a URL that renders nothing. Replace, don't push — a dead link
  // should not become a history entry to go Back to.
  // Gated on `loaded`, not on `!loading`: the node cannot be judged missing
  // until the tree it would live in has actually arrived.
  React.useEffect(() => {
    if (openId && !selected && loaded && !loadError) {
      setOpen(undefined, { replace: true });
    }
  }, [openId, selected, loaded, loadError, setOpen]);

  const closePanel = React.useCallback(() => setOpen(undefined), [setOpen]);

  return (
    <>
      <PageHeader
        title="Materials Management"
        subtitle="Warehouse One and the Cold Storage units. Stock is placed from Receipt Admin."
      />

      <div className="border-b border-border px-6 sm:px-8">
        <nav
          className="inline-flex items-center justify-start gap-1"
          aria-label="Materials Management sections"
        >
          {MM_TABS.map((t) => {
            const isActive = t.seg === tab;
            return (
              <Link
                key={t.seg}
                href={mmHref(t.seg)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  '-mb-px inline-flex items-center whitespace-nowrap border-b-2 border-transparent px-3.5 py-2.5 text-sm font-normal text-text-2 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  isActive && 'border-text font-medium text-text',
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="px-6 py-5 sm:px-8">
        {loadError ? (
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title="Couldn't load Materials Management"
              hint={loadError}
              action={<Button onClick={() => void reload()}>Retry</Button>}
            />
          </div>
        ) : tab === 'warehouse' ? (
          <WarehouseTab
            warehouse={warehouse}
            shelves={shelves}
            loading={loading}
            selectedId={openId}
            onOpen={(shelf) => setOpen(shelf.id)}
          />
        ) : (
          <ColdStorageTab
            locations={coldLocations}
            loading={loading}
            selectedId={openId}
            canManage={isSuperAdmin}
            onOpen={(unit) => setOpen(unit.id)}
            onAddLocation={() => setAddLocation(true)}
            onAddUnit={(loc) => setAddUnitTo(loc)}
            onRename={(node) => setRenaming(node)}
          />
        )}
      </div>

      <NodeContentsSheet
        open={Boolean(selected)}
        onOpenChange={(o) => !o && closePanel()}
        node={selected?.node ?? null}
        pathLabel={selected?.path ?? ''}
        badges={
          tab === 'warehouse' ? (
            <>
              <Badge tone="accent">Warehouse</Badge>
              <Badge tone="neutral">Free placement</Badge>
            </>
          ) : (
            <Badge tone="accent">Cold Storage</Badge>
          )
        }
        canTransfer={canTransfer}
        onChanged={() => void reload()}
      />

      {addLocation && room && (
        <AddNodeDialog
          title="Add Cold Storage location"
          description={`A group inside ${room.name} — for example “Minus-80 Freezers” or “2–8 °C Refrigerators”.`}
          fieldLabel="Name"
          placeholder="e.g. Minus-80 Freezers"
          nodeType="room_location"
          parent={room}
          onClose={() => setAddLocation(false)}
          onDone={() => {
            setAddLocation(false);
            void reload();
          }}
        />
      )}
      {addUnitTo && (
        <AddNodeDialog
          title="Add unit"
          description={`Under ${addUnitTo.name}. The client's equipment number — a T-number plus its unit suffix.`}
          fieldLabel="Equipment number"
          placeholder="e.g. T90020E"
          nodeType="sub_location"
          parent={addUnitTo}
          onClose={() => setAddUnitTo(null)}
          onDone={() => {
            setAddUnitTo(null);
            void reload();
          }}
        />
      )}
      {renaming && (
        <RenameNodeDialog
          node={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

// ── Warehouse tab ──────────────────────────────────────────────────────

function WarehouseTab({
  warehouse,
  shelves,
  loading,
  selectedId,
  onOpen,
}: {
  warehouse: NodeTree | null;
  shelves: NodeTree[];
  loading: boolean;
  selectedId?: string;
  onOpen: (shelf: NodeTree) => void;
}) {
  const [query, setQuery] = React.useState('');
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label="Shelves"
          value={loading ? '—' : String(shelves.length)}
          sub={warehouse?.name ?? undefined}
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
          Nothing sits below a shelf — placement within one is controlled by labeling.
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
                onClick={() => onOpen(shelf)}
                aria-current={shelf.id === selectedId ? 'true' : undefined}
                className={cn(
                  'flex flex-col gap-3 rounded-lg border border-border bg-bg-elev p-4 text-left transition-colors',
                  'hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  !occupied && 'opacity-90',
                  shelf.id === selectedId && 'border-accent',
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
  );
}

// ── Cold Storage tab ───────────────────────────────────────────────────

function ColdStorageTab({
  locations,
  loading,
  selectedId,
  canManage,
  onOpen,
  onAddLocation,
  onAddUnit,
  onRename,
}: {
  locations: NodeTree[];
  loading: boolean;
  selectedId?: string;
  canManage: boolean;
  onOpen: (unit: NodeTree) => void;
  onAddLocation: () => void;
  onAddUnit: (loc: NodeTree) => void;
  onRename: (node: NodeTree) => void;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-56 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-xs text-text-3">
          −20 °C, −80 °C and 2–8 °C refrigerators. Nothing is modeled inside a unit.
        </p>
        {canManage && (
          <Button variant="primary" onClick={onAddLocation}>
            <Plus size={15} /> Add location
          </Button>
        )}
      </div>

      {locations.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-elev">
          <EmptyState
            title="No Cold Storage locations yet"
            hint={
              canManage
                ? 'Add one — for example “Minus-80 Freezers”.'
                : 'A Super Admin adds Cold Storage locations.'
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {locations.map((loc) => (
            <div key={loc.id} className="flex flex-col rounded-lg border border-border bg-bg-elev">
              <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
                <h3 className="text-base font-semibold text-text">{loc.name}</h3>
                <Badge tone="neutral">
                  {loc.children.length} unit{loc.children.length === 1 ? '' : 's'}
                </Badge>
              </div>

              <div className="flex-1 px-4 py-3">
                {loc.children.length === 0 ? (
                  <p className="py-6 text-center text-sm text-text-3">No units yet.</p>
                ) : (
                  loc.children.map((unit) => (
                    <div
                      key={unit.id}
                      className="flex items-center gap-2 border-b border-border/60 py-2 last:border-0"
                    >
                      <button
                        type="button"
                        onClick={() => onOpen(unit)}
                        title={`View contents of ${unit.name}`}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                          unit.id === selectedId && 'text-accent',
                        )}
                      >
                        <Snowflake size={14} className="shrink-0 text-text-3" aria-hidden />
                        <span className="truncate font-mono text-sm">{unit.name}</span>
                      </button>
                      <span
                        className="shrink-0 font-mono text-sm tabular-nums text-text-2"
                        title="On-hand units"
                      >
                        {unit.active_allocation_count}
                      </span>
                      {canManage && (
                        <button
                          type="button"
                          title={`Rename ${unit.name}`}
                          aria-label={`Rename ${unit.name}`}
                          onClick={() => onRename(unit)}
                          className="rounded p-1.5 text-text-3 transition-colors hover:bg-surface hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          <Pencil size={14} />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>

              {canManage && (
                <div className="flex items-center gap-2 border-t border-border px-4 py-3">
                  <Button className="h-8 px-2.5 text-xs" onClick={() => onRename(loc)}>
                    <Pencil size={14} /> Rename
                  </Button>
                  <Button className="h-8 px-2.5 text-xs" onClick={() => onAddUnit(loc)}>
                    <Plus size={14} /> Add unit
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
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

// ── Dialogs ────────────────────────────────────────────────────────────

/** Create a Cold Storage location or one of its units. The name IS the code —
 *  LOC-006 keeps a unit's identifier a single free-text field that the system
 *  never parses, validates or decomposes. */
function AddNodeDialog({
  title,
  description,
  fieldLabel,
  placeholder,
  nodeType,
  parent,
  onClose,
  onDone,
}: {
  title: string;
  description: string;
  fieldLabel: string;
  placeholder: string;
  nodeType: 'room_location' | 'sub_location';
  parent: NodeTree;
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const v = value.trim();
    if (!v) {
      setError(`${fieldLabel} is required.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.create({
        node_type: nodeType,
        code: v,
        name: v,
        parent_id: parent.id,
      });
      toast.success(`${title.replace('Add ', 'Added ')}`, { description: v });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'node_code_conflict') {
        setError(`“${v}” already exists in ${parent.name}.`);
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to add.');
      }
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="add-node-value">{fieldLabel}</Label>
            <Input
              id="add-node-value"
              autoFocus
              className="font-mono"
              placeholder={placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameNodeDialog({
  node,
  onClose,
  onDone,
}: {
  node: NodeTree;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = React.useState(node.name);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const n = name.trim();
    if (!n) {
      setError('A name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.rename(node.id, n);
      toast.success('Renamed', { description: n });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rename.');
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rename-name">Name</Label>
            <Input
              id="rename-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
