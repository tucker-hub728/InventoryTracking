'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, Pencil } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { DeprecationNotice } from '@/components/shared/deprecation-notice';
import { NodeContentsSheet } from '@/components/locations/node-contents-sheet';
import { useHierarchySearch } from '@/components/locations/use-hierarchy-search';
import { RoomSearch } from '@/components/rooms/room-search';
import {
  MM_FREEZER_LOCATION_CODE,
  MM_ROOM_CODE,
  MM_TABS,
  mmHref,
} from '@/components/materials-management/mm-tabs';
import { AddNodeDialog, RenameNodeDialog } from '@/components/rooms/node-dialogs';
import { StorageLeafGrid } from '@/components/rooms/storage-leaf-grid';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
 * entries: Warehouse One's shelves, and the Minus-20 Freezers group with its
 * equipment units. Warehouse used to be its own top-level page; LOC-005 put it
 * inside this room, so it moved in here.
 *
 * Those two locations are all LOC-005 allows, so this page adds nothing but
 * freezer UNITS, and its locations are not renameable. Creating a location
 * belongs to Cold Storage and Production (client rule, 2026-07-30; see
 * ``rooms/room-config.ts``). Shelves cannot be added either: LOC-005 fixes
 * Warehouse One at "sub-locations Shelf A through Shelf Z", a closed set.
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

  const [addUnitTo, setAddUnitTo] = React.useState<NodeTree | null>(null);
  const [renaming, setRenaming] = React.useState<NodeTree | null>(null);

  // Which node's panel is open. Seeded from the URL, then owned here.
  const [openId, setOpenId] = React.useState<string | undefined>(nodeId);
  const [search, setSearch] = React.useState('');

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
      // Pick THIS room by code. /freezer-tree returns every room, sorted by
      // code, so taking rooms[0] silently rendered whichever room sorted first
      // — fine while Materials Management was the only one, wrong the moment
      // Analytical Lab ("AL") or Cold Storage ("CS") is seeded beside it. The
      // warehouse then follows from the room it hangs under, for the same
      // reason: /warehouse-tree is a forest, not this room's warehouse.
      const mmRoom = rooms.find((r) => r.code === MM_ROOM_CODE) ?? null;
      setRoom(mmRoom);
      setWarehouse(warehouses.find((w) => w.parent_id === mmRoom?.id) ?? null);
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

  const shelves = React.useMemo(() => warehouse?.children ?? [], [warehouse]);

  // One search per tab, over whichever location that tab shows. The two are
  // separate trees on separate endpoints, so a single forest would mix shelves
  // into the freezer tab and vice versa.
  const searchForest = React.useMemo(
    () => (tab === 'warehouse' ? (warehouse ? [warehouse] : []) : room ? [room] : []),
    [tab, warehouse, room],
  );
  const found = useHierarchySearch(searchForest, search);

  // The Minus-20 Freezers location, resolved BY CODE — the tab is that one
  // location, so it renders its units rather than a list of locations.
  const freezerLocation = React.useMemo(
    () => room?.children.find((l) => l.code === MM_FREEZER_LOCATION_CODE) ?? null,
    [room],
  );
  const freezerUnits = React.useMemo(
    () => freezerLocation?.children ?? [],
    [freezerLocation],
  );

  // Anything else hanging off this room as a location. LOC-005 allows exactly
  // two (Warehouse One and Minus-20 Freezers), so these are anomalies — but
  // they may hold stock, so they are surfaced rather than dropped.
  const strayLocations = React.useMemo(
    () =>
      (room?.children ?? []).filter(
        (l) => l.node_type === 'room_location' && l.code !== MM_FREEZER_LOCATION_CODE,
      ),
    [room],
  );

  // Resolve the open node against whichever tab is showing.
  const selected = React.useMemo<{ node: NodeTree; path: string } | null>(() => {
    if (!openId) return null;
    if (tab === 'warehouse') {
      const shelf = shelves.find((s) => s.id === openId);
      return shelf
        ? { node: shelf, path: `${warehouse?.name ?? 'Warehouse One'} › ${shelf.name}` }
        : null;
    }
    for (const loc of [freezerLocation, ...strayLocations]) {
      const unit = loc?.children.find((u) => u.id === openId);
      if (unit) return { node: unit, path: `${loc!.name} › ${unit.name}` };
    }
    return null;
  }, [openId, tab, shelves, freezerLocation, strayLocations, warehouse]);

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
      {/* No subtitle — the tabs already name the room's two locations. */}
      <PageHeader title="Materials Management" />
      {/* Being replaced by the Storage template (LOC-001). A signpost only —
          nothing on this page changes, and the room is still in daily use. */}
      <DeprecationNotice id="materials-management" />

      <div className="scroll-strip border-b border-border px-6 sm:px-8">
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
        ) : (
          <>
            <RoomSearch
              value={search}
              onChange={setSearch}
              found={found}
              noun={tab === 'warehouse' ? 'shelves' : 'freezers'}
              placeholder={
                tab === 'warehouse' ? 'Shelf, lot, or item…' : 'Freezer, lot, or item…'
              }
            />
            {tab === 'warehouse' ? (
          // No Add-shelf control: LOC-005 fixes this location's contents at
          // "sub-locations Shelf A through Shelf Z" — a closed set, so there is
          // nothing to add. Renaming stays, since LOC-003 restricts renaming a
          // shelf to the Super Admin rather than forbidding it.
          <StorageLeafGrid
            leaves={shelves}
            loading={loading}
            filterTo={found.active ? found.matchIds : null}
            stockAt={found.stockAt}
            hideSearch
            noun="shelf"
            nounPlural="shelves"
            tileOf={shelfLabel}
            selectedId={openId}
            canManage={isSuperAdmin}
            leadingStat={{
              label: 'Shelves',
              value: loading ? '—' : String(shelves.length),
              sub: warehouse?.name ?? undefined,
            }}
            hint="No structure exists below shelf level — physical placement within a shelf is controlled by labeling."
            emptyTitle="No shelves yet"
            emptyHint="Seed the warehouse shelves (scripts/seed_locations.py)."
            onOpen={(shelf) => setOpen(shelf.id)}
            onRename={(shelf) => setRenaming(shelf)}
          />
        ) : (
          // This tab IS the Minus-20 Freezers location, so it renders that
          // location's UNITS — not a list of locations. Drawing the location
          // itself here produced a "Minus-20 Freezers" panel containing a
          // "Minus-20 Freezers" card: a location nested inside itself.
          //
          // LOC-005 also fixes this room at two locations, so there is no
          // Add-location control and the location is not renameable — creating
          // a location belongs to Cold Storage and Production (client rule,
          // 2026-07-30; see ``rooms/room-config.ts``). Units stay editable.
          <>
            <StorageLeafGrid
              leaves={freezerUnits}
              loading={loading}
              filterTo={found.active ? found.matchIds : null}
              stockAt={found.stockAt}
              hideSearch
              // LOC-005’s own word for this group’s contents: "individual
              // freezer units", "No structure is modeled inside a freezer".
              // Cold Storage keeps "unit" — LOC-002 renamed that category away
              // from "Freezers" precisely because it also holds refrigerators.
              noun="freezer"
              mono
              selectedId={openId}
              canManage={isSuperAdmin}
              leadingStat={{
                label: 'Freezers',
                value: loading ? '—' : String(freezerUnits.length),
                sub: freezerLocation?.name ?? 'Minus-20 Freezers',
              }}
              emptyTitle="No freezers yet"
              emptyHint={
                freezerLocation
                  ? 'Add the first freezer — the client’s equipment number.'
                  : 'Seed the Materials Management room (scripts/seed_locations.py).'
              }
              onOpen={(unit) => setOpen(unit.id)}
              onAdd={freezerLocation ? () => setAddUnitTo(freezerLocation) : undefined}
              onRename={(unit) => setRenaming(unit)}
            />
            {!loading && strayLocations.length > 0 && (
              <StrayLocations
                locations={strayLocations}
                canManage={isSuperAdmin}
                selectedId={openId}
                onOpen={(unit) => setOpen(unit.id)}
                onRename={(node) => setRenaming(node)}
              />
            )}
              </>
            )}
          </>
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
            <Badge tone="accent">Minus-20 Freezers</Badge>
          )
        }
        canTransfer={canTransfer}
        onChanged={() => void reload()}
      />

      {addUnitTo && (
        <AddNodeDialog
          title="Add freezer"
          description={`Under ${addUnitTo.name}. The equipment number is saved exactly as typed.`}
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

// ── Locations that shouldn't be here ───────────────────────────────────

/**
 * Any location in this room beyond the two LOC-005 allows.
 *
 * These are almost always hand-made through the location tree — the dev database
 * has a "Minus-40 Freezers" holding a second copy of T90020B, which is already in
 * the Minus-20 group. LOC-002 records the minus-forty as "believed absent".
 *
 * They are shown rather than filtered out, and shown as a WARNING rather than as
 * another location, because both silent options are worse: hiding them strands
 * any stock inside where no screen can reach it, while drawing them as ordinary
 * locations is how the room ended up looking like it legitimately had three.
 */
function StrayLocations({
  locations,
  canManage,
  selectedId,
  onOpen,
  onRename,
}: {
  locations: NodeTree[];
  canManage: boolean;
  selectedId?: string;
  onOpen: (unit: NodeTree) => void;
  onRename: (node: NodeTree) => void;
}) {
  const units = locations.reduce((n, l) => n + l.children.length, 0);

  return (
    <section className="mt-8 rounded-lg border border-warning/40 bg-warning/5">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-warning/30 px-4 py-3">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-text">
            {locations.length === 1 ? 'An unexpected location' : 'Unexpected locations'} in this
            room
          </h3>
          <p className="mt-0.5 text-xs text-text-2">
            REQ-2026-07-15-LOC-005 gives Materials Management two locations — Warehouse One and
            Minus-20 Freezers. {locations.map((l) => l.name).join(', ')}{' '}
            {locations.length === 1 ? 'is' : 'are'} also here
            {units > 0 && `, holding ${units} unit${units === 1 ? '' : 's'}`}. Added through the
            location tree, not seeded.
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-5 px-4 py-4">
        {locations.map((loc) => (
          <div key={loc.id} className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h4 className="text-sm font-semibold text-text">{loc.name}</h4>
              <Badge tone="warning">Not in LOC-005</Badge>
              {canManage && (
                <Button
                  className="ml-auto h-8 px-2.5 text-xs"
                  onClick={() => onRename(loc)}
                  title={`Rename ${loc.name}`}
                >
                  <Pencil size={14} /> Rename
                </Button>
              )}
            </div>
            {loc.children.length === 0 ? (
              <p className="text-xs text-text-3">
                Empty — safe for a Super Admin to delete from the location tree.
              </p>
            ) : (
              <StorageLeafGrid
                compact
                leaves={loc.children}
                noun="unit"
                mono
                selectedId={selectedId}
                canManage={canManage}
                onOpen={onOpen}
                onRename={onRename}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
