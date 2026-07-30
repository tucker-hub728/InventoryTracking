'use client';

/**
 * One room, and everything in it — room → location → sub-location.
 *
 * Drives Cold Storage and the Analytical Lab. Materials Management keeps its own
 * client because it is the one room with a warehouse in it, so its two locations
 * need different layouts behind tabs; everything the two share now lives in
 * ``location-groups.tsx`` and ``node-dialogs.tsx``.
 *
 * The room is resolved BY CODE. ``/location-nodes/freezer-tree`` returns every
 * room sorted by code, so a page that took the first one would render whichever
 * room happened to sort first.
 *
 * The open panel is reflected in the URL (``/cold-storage/{id}``) so a refresh or
 * a shared link reopens the same unit — but clicking a unit is NOT a router
 * navigation. It rewrites the address bar with ``window.history.pushState``
 * (supported by the App Router since Next 14.1) and opens the panel from local
 * state. Routing would change a dynamic segment's value, and changing a dynamic
 * segment's key unmounts the page subtree and mounts a fresh one — throwing away
 * the loaded tree and refetching it on every click, even though both URLs
 * resolve to the same file. Same reasoning as the Materials Management page.
 */

import * as React from 'react';

import { NodeContentsSheet } from '@/components/locations/node-contents-sheet';
import { useHierarchySearch } from '@/components/locations/use-hierarchy-search';
import { RoomSearch } from '@/components/rooms/room-search';
import { LocationGroups } from '@/components/rooms/location-groups';
import { AddNodeDialog, RenameNodeDialog } from '@/components/rooms/node-dialogs';
import { canRenameLocation, type RoomConfig } from '@/components/rooms/room-config';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import { locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';
import { selectIsSuperAdmin, useAuthStore } from '@/stores/auth.store';

export function RoomClient({
  room: config,
  nodeId,
}: {
  room: RoomConfig;
  /** A sub-location whose contents panel should be open on first paint (from the
   *  URL). After that the panel is driven by local state. */
  nodeId?: string;
}) {
  const canTransfer = usePermission('inventory', 'sign');
  // LOC-003 / LOC-006: only a Super Admin may add or rename Cold Storage nodes.
  // The API enforces this too — this just hides controls that would fail.
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);

  const [room, setRoom] = React.useState<NodeTree | null>(null);
  const [loading, setLoading] = React.useState(true);
  // Distinct from `!loading`: proves a request actually came back with data.
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [addLocation, setAddLocation] = React.useState(false);
  const [addSubTo, setAddSubTo] = React.useState<NodeTree | null>(null);
  const [renaming, setRenaming] = React.useState<NodeTree | null>(null);

  const [openId, setOpenId] = React.useState<string | undefined>(nodeId);
  const [search, setSearch] = React.useState('');

  /** Open/close the panel and keep the address bar in step, without routing. */
  const setOpen = React.useCallback(
    (id: string | undefined, { replace = false } = {}) => {
      setOpenId(id);
      const url = id ? `${config.href}/${id}` : config.href;
      if (typeof window === 'undefined' || window.location.pathname === url) return;
      if (replace) window.history.replaceState(null, '', url);
      else window.history.pushState(null, '', url);
    },
    [config.href],
  );

  // Back/Forward move through the entries pushed above, so re-read the id from
  // the address bar rather than trusting our own state.
  React.useEffect(() => {
    const onPop = () => {
      const parts = window.location.pathname.split('/').filter(Boolean);
      // /{room}/{id?}
      setOpenId(parts.length >= 2 ? decodeURIComponent(parts[1]!) : undefined);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const reload = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoadError(null);
      try {
        const rooms = await locationNodesApi.freezerTree({ signal });
        setRoom(rooms.find((r) => r.code === config.code) ?? null);
        setLoaded(true);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(
          err instanceof ApiError ? err.message : `Failed to load ${config.label}.`,
        );
      } finally {
        // An ABORTED request must not clear `loading`: a `return` inside the
        // catch above still runs this block, and React StrictMode mounts,
        // aborts and remounts in development — so clearing it here would leave
        // loading=false with no data, and the "unknown node" guard below would
        // then rewrite the URL and close the panel on every refresh of a deep
        // link.
        if (!signal?.aborted) setLoading(false);
      }
    },
    [config.code, config.label],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  const locations = React.useMemo(() => room?.children ?? [], [room]);

  // Search the whole room at once — the units live two levels down, so a
  // per-group box would make you repeat the query for every group.
  const roomForest = React.useMemo(() => (room ? [room] : []), [room]);
  const found = useHierarchySearch(roomForest, search);

  const selected = React.useMemo<{ node: NodeTree; path: string } | null>(() => {
    if (!openId) return null;
    for (const loc of locations) {
      const sub = loc.children.find((s) => s.id === openId);
      if (sub) return { node: sub, path: `${loc.name} › ${sub.name}` };
    }
    return null;
  }, [openId, locations]);

  // An id that isn't in this room (stale link, deleted node) shouldn't leave the
  // page stuck on a URL that renders nothing. Replace, don't push — a dead link
  // should not become a history entry to go Back to. Gated on `loaded`, not on
  // `!loading`: the node cannot be judged missing until the tree has arrived.
  React.useEffect(() => {
    if (openId && !selected && loaded && !loadError) {
      setOpen(undefined, { replace: true });
    }
  }, [openId, selected, loaded, loadError, setOpen]);

  const missingRoom = loaded && !loadError && !room;

  return (
    <>
      <PageHeader title={config.label} subtitle={config.subtitle} />

      <div className="px-6 py-5 sm:px-8">
        {loadError ? (
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title={`Couldn't load ${config.label}`}
              hint={loadError}
              action={<Button onClick={() => void reload()}>Retry</Button>}
            />
          </div>
        ) : missingRoom ? (
          // The room's own node is absent, which is a seeding gap rather than a
          // failure — say which script creates it instead of showing an empty
          // grid that looks like "no locations".
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title={`${config.label} isn't set up yet`}
              hint={`No room with code “${config.code}” exists. Seed it with scripts/seed_locations.py.`}
            />
          </div>
        ) : (
          <>
            <RoomSearch
              value={search}
              onChange={setSearch}
              found={found}
              noun={`${config.subLocation.noun}s`}
            />
            <LocationGroups
              locations={locations}
              loading={loading}
              filterTo={found.active ? found.matchIds : null}
              stockAt={found.stockAt}
              hideSearch
              selectedId={openId}
            canManage={isSuperAdmin}
            canAddLocation={config.canAddLocation}
            canRenameLocation={canRenameLocation(config)}
            hint={config.hint}
            subLocationNoun={config.subLocation.noun}
            emptyTitle={`No locations in ${config.label} yet`}
            emptyHint={
              config.canAddLocation && isSuperAdmin
                ? 'Add one — for example “2–8 °C Refrigerators”.'
                : `${config.label}'s locations are seeded. A Super Admin adds any others.`
            }
              onOpen={(sub) => setOpen(sub.id)}
              onAddLocation={
                config.canAddLocation ? () => setAddLocation(true) : undefined
              }
              onAddSubLocation={(loc) => setAddSubTo(loc)}
              onRename={(node) => setRenaming(node)}
            />
          </>
        )}
      </div>

      <NodeContentsSheet
        open={Boolean(selected)}
        onOpenChange={(o) => !o && setOpen(undefined)}
        node={selected?.node ?? null}
        pathLabel={selected?.path ?? ''}
        badges={<Badge tone="accent">{config.label}</Badge>}
        canTransfer={canTransfer}
        onChanged={() => void reload()}
      />

      {addLocation && room && config.addLocation && (
        <AddNodeDialog
          title={config.addLocation.title}
          description={config.addLocation.description}
          fieldLabel={config.addLocation.fieldLabel}
          placeholder={config.addLocation.placeholder}
          nodeType="room_location"
          parent={room}
          onClose={() => setAddLocation(false)}
          onDone={() => {
            setAddLocation(false);
            void reload();
          }}
        />
      )}
      {addSubTo && (
        <AddNodeDialog
          title={config.subLocation.title}
          description={`Under ${addSubTo.name}. ${config.subLocation.description}`}
          fieldLabel={config.subLocation.fieldLabel}
          placeholder={config.subLocation.placeholder}
          nodeType="sub_location"
          parent={addSubTo}
          onClose={() => setAddSubTo(null)}
          onDone={() => {
            setAddSubTo(null);
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
