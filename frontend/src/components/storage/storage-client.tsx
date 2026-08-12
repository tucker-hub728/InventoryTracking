'use client';

/**
 * The Storage room — the locations provisioned from the standard template.
 *
 * REQ-2026-08-04-LOC-001. This screen lists what the client calls "locations"
 * (``storage_category`` nodes) and is where a new one is created. Its sub-types
 * live one level down, on the location's own page.
 *
 * The room is resolved BY CODE, like every other room:
 * ``/location-nodes/freezer-tree`` returns them all, so a page that took the
 * first would render whichever room happened to sort first.
 *
 * A card grid rather than a table: a location is a place, and its interesting
 * content is which sub-types it uses and how much sits in each — three small
 * facts that read better side by side than as columns most of which are empty.
 */

import * as React from 'react';
import Link from 'next/link';
import { Boxes, Plus } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Stat } from '@/components/rooms/storage-leaf-grid';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/client';
import { locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';
import { selectIsSuperAdmin, useAuthStore } from '@/stores/auth.store';
import { cn } from '@/lib/utils';

import { CreateStorageLocationDialog } from './create-storage-location-dialog';
import {
  DEFAULT_GROUP_SEGMENT,
  STORAGE_GROUPS,
  STORAGE_ROOM_CODE,
  groupByCode,
  storageHref,
} from './storage-groups';

export function StorageClient() {
  // LOC-004: the template's sub-locations are admin-configurable, on the same
  // footing as the rest of location administration. The API enforces it too —
  // this only hides controls that would fail.
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);

  const [room, setRoom] = React.useState<NodeTree | null>(null);
  const [loading, setLoading] = React.useState(true);
  // Distinct from `!loading`: proves a request actually came back with data.
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const reload = React.useCallback(async (signal?: AbortSignal) => {
    setLoadError(null);
    try {
      const rooms = await locationNodesApi.freezerTree({ signal });
      setRoom(rooms.find((r) => r.code === STORAGE_ROOM_CODE) ?? null);
      setLoaded(true);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load Storage.');
    } finally {
      // An ABORTED request must not clear `loading`: React StrictMode mounts,
      // aborts and remounts in development, so clearing it here would leave
      // loading=false with no data and flash the "not set up yet" state.
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  /** Sorted by name, not by the tree's code order — the client names these, so
   *  the list should read the way they'd look one up. */
  const categories = React.useMemo(
    () =>
      [...(room?.children ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      ),
    [room],
  );
  // No "the room is missing" state any more. The Storage room is created by the
  // server the first time a location is, so an absent room means exactly what an
  // empty room means: no locations yet. It used to render a dead end telling you
  // to run a seed script — which is a deploy step nobody using the screen can
  // action, and which hid the one button that would have fixed it.
  const noLocations = loaded && !loadError && categories.length === 0;

  /**
   * Two different things get counted here, and the page used to call both
   * "units": the UNITS are the equipment (shelves, refrigerators, freezers —
   * what Cold Storage's "Add unit" means), and the STOCK is what sits in them.
   * A card reading "9 units" beside a tile reading "160 units of stock" made one
   * word mean two things on one screen, so the wording is kept apart here.
   */
  const totals = React.useMemo(() => {
    let units = 0;
    let occupied = 0;
    let stock = 0;
    for (const cat of categories) {
      for (const group of cat.children ?? []) {
        for (const leaf of group.children ?? []) {
          units += 1;
          if (leaf.active_allocation_count > 0) occupied += 1;
          stock += leaf.active_allocation_count;
        }
      }
    }
    return { units, occupied, stock };
  }, [categories]);

  return (
    <>
      <PageHeader
        title="Storage"
        subtitle="Locations built from the standard template — a shelf, a refrigerator and a freezer, each optional."
        actions={
          // Not gated on the room existing — creating the first location is what
          // brings the room into being.
          isSuperAdmin ? (
            <Button type="button" variant="primary" onClick={() => setCreating(true)}>
              <Plus size={15} />
              <span className="ml-1.5">Create new location</span>
            </Button>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        {loadError ? (
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title="Couldn't load Storage"
              hint={loadError}
              action={<Button onClick={() => void reload()}>Retry</Button>}
            />
          </div>
        ) : noLocations && !loading ? (
          // Nothing here yet — whether or not the room row exists, which is the
          // server's business and not something to explain on screen.
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              icon={Boxes}
              title="No locations yet"
              hint={
                isSuperAdmin
                  ? 'Create one — name it, then choose which of shelf, refrigerator and freezer it uses.'
                  : 'A Super Admin creates locations here.'
              }
              action={
                isSuperAdmin ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus size={15} />
                    <span className="ml-1.5">Create new location</span>
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat
                label="Locations"
                value={loading ? '—' : String(categories.length)}
                sub="built from the template"
              />
              <Stat
                label="Units"
                value={loading ? '—' : String(totals.units)}
                sub={
                  loading
                    ? undefined
                    : totals.units === 0
                      ? 'shelves, refrigerators & freezers'
                      : `${totals.occupied} holding stock`
                }
              />
              {/* Was labelled "Occupied" while showing the stock total — two
                  different measures under one word. Occupancy is now the sub of
                  Units, where it belongs, and this tile says what it counts. */}
              <Stat
                label="Stock on hand"
                value={loading ? '—' : totals.stock.toLocaleString()}
                sub={totals.stock > 0 ? 'units of stock placed here' : 'nothing placed yet'}
              />
            </div>

            {loading ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-32 rounded-lg" />
                ))}
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {categories.map((cat) => (
                  <CategoryCard key={cat.id} category={cat} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {creating && (
        <CreateStorageLocationDialog
          existingNames={categories.map((c) => c.name)}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void reload();
          }}
        />
      )}
    </>
  );
}

/** One location: its name, what it holds, and the sub-types it uses. */
function CategoryCard({ category }: { category: NodeTree }) {
  const groups = category.children ?? [];
  // Open on the location's FIRST group rather than the template's first — a
  // location with Shelf switched off has no `shf` tab to land on.
  const firstSegment = groupByCode(groups[0]?.code)?.segment ?? DEFAULT_GROUP_SEGMENT;

  const stock = groups.reduce(
    (sum, g) => sum + (g.children ?? []).reduce((s, l) => s + l.active_allocation_count, 0),
    0,
  );
  const units = groups.reduce((sum, g) => sum + (g.children ?? []).length, 0);

  return (
    <li>
      <Link
        href={storageHref(category.id, firstSegment)}
        className="group flex h-full flex-col rounded-lg border border-border bg-bg-elev transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="flex items-start justify-between gap-3 p-4 pb-3">
          <div className="min-w-0">
            {/* The name only. A node's ``code`` is machine identity — it keeps
                links and seeds stable across a rename — and means nothing to
                whoever is reading the card, where it just repeats the name in a
                stranger form (client, 2026-08-12). Nothing user-facing shows
                it. */}
            <p className="truncate text-sm font-medium text-text">{category.name}</p>
            <p className="mt-0.5 text-xs text-text-3">
              {units === 0
                ? 'No units yet'
                : `${units} ${units === 1 ? 'unit' : 'units'}`}
            </p>
          </div>
          {/* What the card is really for: telling a location that holds
              something from one that does not, without reading three rows. */}
          {stock > 0 ? (
            <Badge tone="accent">{stock.toLocaleString()} in stock</Badge>
          ) : (
            <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-text-3">
              Empty
            </span>
          )}
        </div>

        {groups.length === 0 ? (
          // A location whose sub-types were all switched off. Three "not used"
          // rows would describe it accurately and tell you nothing about what to
          // do, so it says the one thing that matters.
          <p className="border-t border-border px-4 py-3 text-xs text-text-3">
            No sub-types — switch one on from the location’s menu.
          </p>
        ) : (
          <dl className="mt-auto space-y-1.5 border-t border-border px-4 py-3">
            {/* Iterate the TEMPLATE, not the category's children, so every card
                lists the same three rows in the same places and an unused
                sub-type reads as deliberately off rather than missing. */}
            {STORAGE_GROUPS.map((tpl) => {
              const group = groups.find((g) => g.code.toUpperCase() === tpl.code);
              const count = group ? (group.children ?? []).length : 0;
              const Icon = tpl.icon;
              return (
                <div
                  key={tpl.code}
                  className={cn(
                    'flex items-center gap-2 text-xs',
                    group ? 'text-text-2' : 'text-text-3/70',
                  )}
                >
                  <Icon
                    size={13}
                    className={cn('shrink-0', group ? 'text-accent' : 'text-text-3/60')}
                  />
                  {/* The group's OWN name — the client may have renamed it. */}
                  <span className="truncate">{group?.name ?? tpl.defaultName}</span>
                  <span className="ml-auto shrink-0 tabular-nums">
                    {!group ? 'not used' : count === 0 ? '—' : count}
                  </span>
                </div>
              );
            })}
          </dl>
        )}
      </Link>
    </li>
  );
}
