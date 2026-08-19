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

import { CreateStorageLocationDialog } from './create-storage-location-dialog';
import {
  DEFAULT_GROUP_SEGMENT,
  STORAGE_ROOM_CODE,
  groupFor,
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
      // The tree alone now. This used to also fetch ``issuesApi.summary`` for the
      // debit-and-gone cards; those moved to their own section on 2026-08-19, and
      // nothing left on this page is about material that has LEFT inventory.
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

  /** The STORAGE locations, sorted by name — not the tree's code order, since
   *  the client names these and would look one up by name.
   *
   *  ``is_scrap`` locations are filtered OUT (2026-08-19): they have their own
   *  section at ``/debit-and-gone``. They are still siblings in the tree — a
   *  debit-and-gone location is an ordinary ``storage_category`` row with a
   *  marker, not a node type of its own — so this page selects rather than
   *  reads a different room. Before the split they sat in this grid as cards
   *  answering a different question ("what left through here") under stat tiles
   *  that could only ever describe the storage half. */
  const categories = React.useMemo(
    () =>
      (room?.children ?? [])
        .filter((c) => !c.is_scrap)
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
        ),
    [room],
  );
  /** Every name in the room, INCLUDING the debit-and-gone ones. The create
   *  dialog checks against all of them: the server's uniqueness rule is over
   *  siblings, and it does not care which kind of location a name belongs to. */
  const allNames = React.useMemo(() => (room?.children ?? []).map((c) => c.name), [room]);
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
              {/* Was "built from the template" — false since 2026-08-19, when
                  locations stopped being provisioned from one and started life
                  bare. All three tiles now describe ONE kind of place: the
                  debit-and-gone locations moved to their own section, so the
                  Stock-on-hand figure beside this count finally covers every
                  card on the page. */}
              <Stat
                label="Locations"
                value={loading ? '—' : String(categories.length)}
                sub="in Storage"
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
          existingNames={allNames}
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
  // Open on the location's FIRST sub-type rather than the first KIND — a
  // location with no shelf has no `shf` tab to land on, and one whose first
  // sub-type is a second freezer (`FRZ-2`) is not found by a kind lookup either.
  // Either way the card would click through into a redirect.
  const firstSegment = groups[0] ? groupFor(groups[0]).segment : DEFAULT_GROUP_SEGMENT;

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
              {units === 0 ? 'No units yet' : `${units} ${units === 1 ? 'unit' : 'units'}`}
            </p>
          </div>
          {/* What the card is really for: telling a location that holds
              something from one that does not, without reading three rows. */}
          <div className="flex shrink-0 flex-col items-end gap-1">
            {stock > 0 ? (
              <Badge tone="accent">{stock.toLocaleString()} in stock</Badge>
            ) : (
              <span className="text-[11px] font-medium uppercase tracking-wide text-text-3">
                Empty
              </span>
            )}
          </div>
        </div>

        {groups.length === 0 ? (
          // A location whose sub-types were all switched off. Three "not used"
          // rows would describe it accurately and tell you nothing about what to
          // do, so it says the one thing that matters.
          //
          // This is how every location STARTS now, so it is the first thing seen
          // after creating one — not a misconfiguration. The debit-and-gone
          // branch that used to live here is gone with them: they are filtered
          // out of this grid entirely.
          <p className="border-t border-border px-4 py-3 text-xs text-text-3">
            No sub-types yet — add them from the location’s menu.
          </p>
        ) : (
          <dl className="mt-auto space-y-1.5 border-t border-border px-4 py-3">
            {/* The location's ACTUAL sub-types, one row each.
                This used to iterate the three kinds and match a group by exact
                code, which held only while a location had at most one of each.
                It now can have several ("Minus-20 Freezer", "Minus-80 Freezer",
                codes FRZ and FRZ-2) or none at all — and the old lookup would
                have reported a location whose only freezer is FRZ-2 as having no
                freezer, because it searched for the bare code. */}
            {groups.length === 0 ? (
              <div className="text-xs text-text-3/70">No sub-types yet</div>
            ) : (
              groups.map((group) => {
                const Icon = groupFor(group).icon;
                const count = (group.children ?? []).length;
                return (
                  <div key={group.id} className="flex items-center gap-2 text-xs text-text-2">
                    <Icon size={13} className="shrink-0 text-accent" />
                    {/* The sub-type's OWN name — the client named it. */}
                    <span className="truncate">{group.name}</span>
                    <span className="ml-auto shrink-0 tabular-nums">
                      {count === 0 ? '—' : count}
                    </span>
                  </div>
                );
              })
            )}
          </dl>
        )}
      </Link>
    </li>
  );
}
