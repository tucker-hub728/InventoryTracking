'use client';

/**
 * A room's locations, one section each, with that location's units as a grid.
 *
 * Use this only for a room that genuinely has SEVERAL locations to distinguish —
 * Cold Storage (Minus-20, Minus-80, and the refrigerators once the client's list
 * arrives). A room whose tab already names one location must render that
 * location's leaves directly instead, with ``StorageLeafGrid``: wrapping them in
 * a location card there produced a "Minus-20 Freezers" panel containing a
 * "Minus-20 Freezers" card, which is a location inside itself.
 *
 * A section, not a card. Cards imply peers you choose between; these are
 * headings over one continuous inventory of the room, and the units inside them
 * are the things you actually click. Nesting clickable cards inside decorative
 * cards was the old shape and it buried the units two frames deep.
 *
 * Which controls appear follows the client's add rule (see ``room-config.ts``):
 * only Cold Storage and Production may add a location, every other room adds
 * sub-locations only, and renaming follows adding. All of it is Super-Admin-only
 * on the API side (LOC-003 / LOC-006) — ``canManage`` only hides controls that
 * would fail.
 */

import * as React from 'react';
import { Pencil, Plus } from 'lucide-react';

import { StorageLeafGrid } from '@/components/rooms/storage-leaf-grid';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { NodeTree } from '@/lib/api/location-nodes';

export function LocationGroups({
  locations,
  loading,
  selectedId,
  canManage,
  canAddLocation,
  canRenameLocation,
  hint,
  subLocationNoun,
  emptyTitle,
  emptyHint,
  filterTo,
  stockAt,
  hideSearch,
  onOpen,
  onAddLocation,
  onAddSubLocation,
  onRename,
}: {
  locations: NodeTree[];
  loading: boolean;
  selectedId?: string;
  /** The signed-in user may manage this room's structure (Super Admin). */
  canManage: boolean;
  /** This room may create a new location. */
  canAddLocation: boolean;
  /** This room may rename a location (follows ``canAddLocation``). */
  canRenameLocation: boolean;
  hint?: string;
  /** Singular noun for a sub-location here — "unit", "shelf". */
  subLocationNoun: string;
  emptyTitle: string;
  emptyHint: string;
  /** Leaf ids a page-level search matched. Null = not searching. */
  filterTo?: Set<string> | null;
  /** The page owns the search — nested grids render no box of their own. */
  hideSearch?: boolean;
  /** Lot / item found at a leaf by that search. */
  stockAt?: Map<string, { lots: string[]; items: string[] }>;
  onOpen: (subLocation: NodeTree) => void;
  onAddLocation?: () => void;
  onAddSubLocation: (location: NodeTree) => void;
  onRename: (node: NodeTree) => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3">
            <Skeleton className="h-6 w-52" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
              {Array.from({ length: 4 }).map((_, j) => (
                <Skeleton key={j} className="h-24 rounded-lg" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // While searching, a location with no matching unit is dropped entirely — an
  // empty heading under a search reads as "this group is empty", which is a
  // different and wrong statement.
  const visible = filterTo
    ? locations.filter((loc) => loc.children.some((c) => filterTo.has(c.id)))
    : locations;

  const totals = locations.reduce(
    (acc, loc) => {
      acc.leaves += loc.children.length;
      acc.units += loc.children.reduce((s, c) => s + c.active_allocation_count, 0);
      return acc;
    },
    { leaves: 0, units: 0 },
  );

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        {hint ? <p className="text-xs text-text-3">{hint}</p> : <span />}
        <div className="flex items-center gap-3">
          {locations.length > 0 && (
            <p className="hidden text-xs tabular-nums text-text-3 sm:block">
              {locations.length} location{locations.length === 1 ? '' : 's'} ·{' '}
              {totals.leaves} {subLocationNoun}
              {totals.leaves === 1 ? '' : 's'} · {totals.units.toLocaleString()} units on hand
            </p>
          )}
          {canManage && canAddLocation && onAddLocation && (
            <Button variant="primary" onClick={onAddLocation}>
              <Plus size={15} /> Add location
            </Button>
          )}
        </div>
      </div>

      {locations.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-elev">
          <EmptyState title={emptyTitle} hint={emptyHint} />
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-elev">
          <EmptyState
            title={`No ${subLocationNoun}s match`}
            hint="Try a different search."
          />
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {visible.map((loc) => (
            <section key={loc.id} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border pb-2.5">
                <h3 className="text-base font-semibold text-text">{loc.name}</h3>
                <Badge tone="neutral">
                  {loc.children.length} {subLocationNoun}
                  {loc.children.length === 1 ? '' : 's'}
                </Badge>
                <div className="ml-auto flex items-center gap-2">
                  {canManage && canRenameLocation && (
                    <Button
                      className="h-8 px-2.5 text-xs"
                      onClick={() => onRename(loc)}
                      title={`Rename ${loc.name}`}
                    >
                      <Pencil size={14} /> Rename
                    </Button>
                  )}
                  {canManage && (
                    <Button
                      className="h-8 px-2.5 text-xs"
                      onClick={() => onAddSubLocation(loc)}
                    >
                      <Plus size={14} /> Add {subLocationNoun}
                    </Button>
                  )}
                </div>
              </div>

              <StorageLeafGrid
                compact
                leaves={loc.children}
                filterTo={filterTo}
                stockAt={stockAt}
                hideSearch={hideSearch}
                noun={subLocationNoun}
                mono
                selectedId={selectedId}
                canManage={canManage}
                emptyTitle={`No ${subLocationNoun}s in ${loc.name} yet`}
                emptyHint={
                  canManage
                    ? `Add one with “Add ${subLocationNoun}” above.`
                    : `A Super Admin adds ${subLocationNoun}s.`
                }
                onOpen={onOpen}
                onRename={onRename}
              />
            </section>
          ))}
        </div>
      )}
    </>
  );
}
