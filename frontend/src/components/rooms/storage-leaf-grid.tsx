'use client';

/**
 * The leaves of one location, as a grid of cards — a warehouse's shelves, or a
 * freezer group's equipment units.
 *
 * Both are the same thing structurally: a sub-location that holds stock and has
 * nothing inside it (LOC-005 for shelves, LOC-006 for units — "no structure
 * shall be modeled inside a Cold Storage unit"). They used to be drawn two
 * different ways, shelves as cards and units as table rows, which made one room
 * look like two products. One component now, so a room reads as one place.
 *
 * A card is deliberately the end of the road: there is no expand affordance,
 * because there is nothing below a leaf to expand into. Clicking opens its
 * contents panel.
 *
 * Occupancy is shown as a count and as weight — an empty leaf recedes. There is
 * deliberately NO capacity bar: a shelf and a freezer have no modeled capacity,
 * so a "60% full" bar would be invented. The number is what we actually know.
 */

import * as React from 'react';
import { Boxes, Pencil, Plus, Search } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { leafAnchorId } from './room-shortcuts';
import type { NodeTree } from '@/lib/api/location-nodes';

/** Search appears once a grid is long enough to need it. 26 shelves do; three
 *  freezer units do not, and an empty search box on three cards is noise. */
const SEARCHABLE_FROM = 8;

export interface StorageLeafGridProps {
  leaves: NodeTree[];
  loading?: boolean;
  /** Singular noun for one leaf — "shelf", "unit". */
  noun: string;
  /** Plural, when it isn't ``noun + 's'``. */
  nounPlural?: string;
  /** Tile content for a leaf — a shelf's letter. Omit for a mono name card. */
  tileOf?: (leaf: NodeTree) => React.ReactNode;
  /** Render the leaf's name in monospace. True for equipment numbers. */
  mono?: boolean;
  selectedId?: string;
  /** Super Admin — controls whether Add / Rename render at all. */
  canManage?: boolean;
  /** One line of context above the grid. */
  hint?: string;
  /** Extra stat tiles to sit beside the built-in occupancy summary. */
  leadingStat?: { label: string; value: string; sub?: string };
  /** Hide the summary row — for a compact grid nested under a section header. */
  compact?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  /**
   * Ids to show, when a PAGE-level search is driving the grid. Null = no search.
   *
   * The page owns that search because it spans the whole room and reaches
   * further than a name: ``useHierarchySearch`` also resolves lot and item
   * numbers, which a leaf cannot answer for itself (a node carries an occupancy
   * count, never what is inside it). When it is active the grid's own box is
   * redundant, so it hides.
   */
  filterTo?: Set<string> | null;
  /** The PAGE owns the search, so this grid renders no box of its own.
   *  Distinct from filterTo, which is null while the page query is empty —
   *  keying off that alone made both boxes appear until something was typed. */
  hideSearch?: boolean;
  /** Lot / item found at a leaf by that search — shown in place of the count. */
  stockAt?: Map<string, { lots: string[]; items: string[] }>;
  onOpen: (leaf: NodeTree) => void;
  onAdd?: () => void;
  onRename?: (leaf: NodeTree) => void;
}

export function StorageLeafGrid({
  leaves,
  loading = false,
  noun,
  nounPlural,
  tileOf,
  mono = false,
  selectedId,
  canManage = false,
  hint,
  leadingStat,
  compact = false,
  emptyTitle,
  emptyHint,
  filterTo,
  stockAt,
  hideSearch = false,
  onOpen,
  onAdd,
  onRename,
}: StorageLeafGridProps) {
  const plural = nounPlural ?? `${noun}s`;
  const [query, setQuery] = React.useState('');
  const q = query.trim().toLowerCase();
  const pageSearching = filterTo != null;

  const filtered = React.useMemo(() => {
    // A page-level search wins — it already matched on more than this grid can.
    if (filterTo) return leaves.filter((l) => filterTo.has(l.id));
    if (!q) return leaves;
    return leaves.filter(
      (l) => l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q),
    );
  }, [leaves, q, filterTo]);

  const stats = React.useMemo(() => {
    const occupied = leaves.filter((l) => l.active_allocation_count > 0).length;
    const units = leaves.reduce((sum, l) => sum + l.active_allocation_count, 0);
    return { occupied, units };
  }, [leaves]);

  // Hidden while a page-level search is running — two boxes filtering one
  // grid is a puzzle, not a feature.
  const searchable = !hideSearch && !pageSearching && leaves.length >= SEARCHABLE_FROM;

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {Array.from({ length: compact ? 4 : 12 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <>
      {!compact && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {leadingStat ? (
            <Stat {...leadingStat} />
          ) : (
            <Stat
              label={plural}
              value={String(leaves.length)}
              icon={<Boxes size={15} />}
            />
          )}
          <Stat
            label="Occupied"
            value={String(stats.occupied)}
            sub={`of ${leaves.length} ${leaves.length === 1 ? noun : plural}`}
          />
          <Stat
            label="Units on hand"
            value={stats.units.toLocaleString()}
            sub={`across all ${plural}`}
          />
        </div>
      )}

      {(hint || searchable || (canManage && onAdd)) && (
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-3',
            !compact && 'mt-5',
          )}
        >
          {searchable ? (
            <div className="max-w-xs flex-1">
              <Input
                icon={Search}
                placeholder={`Search ${noun}…`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={`Search ${plural}`}
              />
            </div>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            {hint && <p className="hidden text-xs text-text-3 sm:block">{hint}</p>}
            {canManage && onAdd && (
              <Button onClick={onAdd}>
                <Plus size={15} /> Add {noun}
              </Button>
            )}
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className={cn('rounded-lg border border-border bg-bg-elev', !compact && 'mt-4')}>
          <EmptyState
            title={
              q || pageSearching ? `No ${plural} match` : (emptyTitle ?? `No ${plural} yet`)
            }
            hint={
              q || pageSearching
                ? 'Try a different search.'
                : (emptyHint ??
                  (canManage && onAdd
                    ? `Add the first ${noun}.`
                    : `A Super Admin adds ${plural}.`))
            }
          />
        </div>
      ) : (
        <div
          className={cn(
            'grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6',
            !compact && 'mt-4',
          )}
        >
          {filtered.map((leaf) => (
            <LeafCard
              key={leaf.id}
              leaf={leaf}
              tile={tileOf?.(leaf)}
              stock={stockAt?.get(leaf.id)}
              mono={mono}
              selected={leaf.id === selectedId}
              canManage={canManage}
              onOpen={() => onOpen(leaf)}
              onRename={onRename ? () => onRename(leaf) : undefined}
            />
          ))}
        </div>
      )}
    </>
  );
}

function LeafCard({
  leaf,
  tile,
  stock,
  mono,
  selected,
  canManage,
  onOpen,
  onRename,
}: {
  leaf: NodeTree;
  tile?: React.ReactNode;
  /** What a page-level search found inside this leaf, if it matched that way. */
  stock?: { lots: string[]; items: string[] };
  mono: boolean;
  selected: boolean;
  canManage: boolean;
  onOpen: () => void;
  onRename?: () => void;
}) {
  const occupied = leaf.active_allocation_count > 0;
  const showRename = canManage && Boolean(onRename);
  // The lot naming the match beats the bare count — it is why this card is here.
  const found = stock?.lots[0] ?? stock?.items[0];

  return (
    // A div wrapping two buttons, not a button itself — Rename has to be its own
    // control, and a button inside a button is invalid markup that browsers
    // resolve unpredictably.
    <div
      // Scroll target for the A–Z rail (UI-002).
      id={leafAnchorId(leaf.id)}
      className={cn(
        'relative flex flex-col rounded-lg border border-border bg-bg-elev transition-colors',
        'hover:border-accent focus-within:border-accent',
        // Keeps a rail jump from landing the card flush under the sticky search.
        'scroll-mt-32',
        !occupied && 'opacity-90',
        selected && 'border-accent',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        title={`View contents of ${leaf.name}`}
        aria-current={selected ? 'true' : undefined}
        className="flex flex-1 flex-col gap-3 rounded-lg p-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="flex items-start justify-between gap-2">
          {tile ? (
            <div className="grid size-10 place-items-center rounded-md bg-surface-2 font-mono text-lg font-semibold text-text">
              {tile}
            </div>
          ) : (
            <span />
          )}
          {found ? (
            <span
              title={
                [
                  stock?.lots.length ? `Holds ${stock.lots.join(', ')}` : null,
                  stock?.items.length ? `Item ${stock.items.join(', ')}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || undefined
              }
              className="max-w-[7rem] truncate rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-accent"
            >
              {found}
              {(stock?.lots.length ?? 0) > 1 && ` +${(stock?.lots.length ?? 1) - 1}`}
            </span>
          ) : occupied ? (
            <Badge tone="neutral">{leaf.active_allocation_count} units</Badge>
          ) : (
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-3">
              Empty
            </span>
          )}
        </div>
        <div
          className={cn(
            'break-words text-text-2',
            mono ? 'font-mono text-sm font-semibold text-text' : 'text-xs',
            // With no tile the name is the card's whole identity, so give it the
            // room the tile would have taken.
            !tile && 'mt-1',
          )}
        >
          {leaf.name}
        </div>
      </button>
      {showRename && (
        <button
          type="button"
          title={`Rename ${leaf.name}`}
          aria-label={`Rename ${leaf.name}`}
          onClick={onRename}
          className="absolute bottom-2 right-2 rounded p-1.5 text-text-3 transition-colors hover:bg-surface hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Pencil size={14} />
        </button>
      )}
    </div>
  );
}

export function Stat({
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
      <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-text">
        {value}
      </div>
      {sub && <div className="text-xs text-text-3">{sub}</div>}
    </div>
  );
}
