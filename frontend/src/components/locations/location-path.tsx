'use client';

/**
 * THE way to show a storage location. There is deliberately only one.
 *
 * A location is shown as its NAME, with the full hierarchy one hover away, and it
 * opens the page that location lives on when there is one.
 *
 * A stored path reads "Storage › Materials Management › Shelf › Shelf A". Printed
 * into a table column that is three problems at once: it truncates to
 * "Storage › Materials Manage…" so the one part that identifies the place — the
 * last — is the part you lose; every row repeats the same ancestors, which carry
 * no information when they are identical down the column; and it is five times
 * wider than the fact it conveys.
 *
 * So the cell shows the leaf, and the ancestry is available on demand. The tooltip
 * draws it as a descent rather than re-printing the slash-separated string,
 * because the relationship between the parts IS the content — and the leaf is
 * marked so the eye lands on the same word it just hovered.
 *
 * A tooltip, not a click-popover: this is a reference detail, and requiring a
 * click to read where something came from turns a glance into a task. Radix opens
 * it on focus too, so it is reachable without a mouse.
 *
 * ── Why this file is a merge ──────────────────────────────────────────────
 *
 * This replaces two components that disagreed about the same thing:
 *
 *   * ``LocationLink`` — leaf, linked, but only a native ``title=""`` tooltip, so
 *     hovering a location in the Unit Ledger produced a grey OS bubble;
 *   * ``LocationPath`` — leaf with this rich descent panel, but no link.
 *
 * A user hovering two locations on two screens got two different answers, and a
 * third set of screens printed the raw path instead. One component, one answer:
 * hover always reveals the hierarchy, click always opens the place when it has a
 * page. The routing lives here too — deciding WHICH page a node opens is part of
 * showing it, and splitting them is what let the two versions drift apart.
 */

import * as React from 'react';
import Link from 'next/link';
import { CornerDownRight, MapPin } from 'lucide-react';

import { DEFAULT_FLOOR_TAB, FLOOR_TABS } from '@/components/production/floor-tabs';
import {
  DEFAULT_GROUP_SEGMENT,
  STORAGE_ROOM_CODE,
  groupFor,
  storageHref,
} from '@/components/storage/storage-groups';
import {
  nodeChain,
  useLocationForest,
  type Forest,
  type PNode,
} from '@/components/reconciliation/location-tree-picker';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { KitStatus } from '@/lib/api/kits';
import { cn } from '@/lib/utils';

/** The synthetic LN2 group's id, from the forest builder. */
const LN2_GROUP_ID = 'grp:ln2';

/** The floor tab that lists a room's Kanban stations. Derived, not hard-coded,
 *  so renaming the segment in one place stays enough. */
const KANBAN_TAB = FLOOR_TABS.find((t) => t.kind === 'kanban')?.seg ?? 'kanban';

/**
 * Which tab of a production floor holds a kit in this state.
 *
 * A floor page is three tabs of kits, and `/production/{id}` alone redirects to
 * the first one. So arriving from a CLOSED kit's ledger row used to land on "In
 * production" — a real page, showing everything except the kit you clicked from.
 *
 * ``draft`` and ``issued`` fold into in-production alongside ``in_production``:
 * the floor groups kits into three sections, not five, and that split already
 * matches how the ledger phrases the same three states.
 */
function floorTabFor(status: KitStatus): string {
  const section =
    status === 'closed' ? 'closed' : status === 'cancelled' ? 'cancelled' : 'in_production';
  // Only the kit-state tabs are addressable by section; the Kanban tab is a
  // stock view and no kit ever links to it.
  return (
    FLOOR_TABS.find((t) => t.kind === 'kits' && t.section === section)?.seg ?? DEFAULT_FLOOR_TAB
  );
}

/**
 * Route for a node, or null when it has no page to open.
 *
 * Every storage area has a route, but they are not one route — which page a node
 * belongs to depends on where it hangs, so the href is derived from the node's
 * ancestry rather than from the node itself:
 *
 *   Storage               →  /storage/{category}/{tab}/{id}
 *   LN2                   →  /ln2/{tank}/{quadrant}/{rack}/{box}
 *   Production            →  /production/{id}
 *
 * Note LN2 wants the whole chain of ids, not just the leaf. Only the last segment
 * drives selection; the ancestors are there so the URL reads as the physical
 * address and a shared link says where in the tank to look.
 */
export function locationHref(
  forest: Forest,
  nodeId: string,
  /** The kit whose row this link sits on, when there is one — picks the floor tab. */
  kitStatus?: KitStatus | null,
): string | null {
  const chain = nodeChain(forest, nodeId);
  const node = chain.at(-1);
  const root = chain[0];
  // A synthetic group is a heading, not a place — nothing to open.
  if (!node || !root || node.isGroup) return null;

  // A Kanban has no page of its own — it is a station INSIDE a production area,
  // listed on that area's Kanban tab (LOC-006 / consum01). Checked before the
  // production branch below, which would otherwise build `/production/{kanbanId}`
  // and open a floor page for an id that is not a floor.
  if (node.nodeType === 'kanban') {
    const area = chain.filter((n) => !n.isGroup).at(-2);
    return area ? `/production/${area.id}/${KANBAN_TAB}` : null;
  }

  // A production floor is its own page, whatever else is true of it — opened at
  // the tab that actually contains the kit, when the caller knows which.
  if (node.area === 'production') {
    return kitStatus ? `/production/${node.id}/${floorTabFor(kitStatus)}` : `/production/${node.id}`;
  }

  if (root.id === LN2_GROUP_ID) {
    const ids = chain.filter((n) => !n.isGroup).map((n) => n.id);
    return ids.length > 0 ? `/ln2/${ids.join('/')}` : null;
  }

  switch (root.code) {
    case STORAGE_ROOM_CODE: {
      // Storage is the one room four levels deep — room › category › group ›
      // unit (LOC-001) — so its href needs two ids, not one: the category owns
      // the page and the group is the tab. Anything shallower opens the page at
      // whichever tab it can.
      const real = chain.filter((n) => !n.isGroup);
      const category = real.find((n) => n.nodeType === 'storage_category');
      if (!category) return null;
      // The group is whatever sits between the category and the leaf. Its tab is
      // found by CODE, which is immutable — the client may rename "Shelf" to
      // "Racks" without breaking a link already in the ledger.
      const group = real[real.indexOf(category) + 1];
      // The category itself opens the page; a group opens its tab; a unit opens
      // its tab with the contents panel up.
      const isUnit = node.id !== category.id && node.id !== group?.id;
      // A debit-and-gone location has its own section (2026-08-19) — it stores
      // nothing, so none of the Storage page applies to it. Checked before the
      // segment logic below: such a location has no sub-types at all, so there
      // is no tab to compute and nothing under it to be a unit of.
      if (category.isScrap) {
        return `/debit-and-gone/${category.id}`;
      }
      // Any sub-type, not just the template's three: a ledger row naming a unit
      // inside a sub-type the client added (code ``GRP-1``) still has to link to
      // the tab that unit is actually on.
      const segment = group ? groupFor(group).segment : DEFAULT_GROUP_SEGMENT;
      return storageHref(category.id, segment, isUnit ? node.id : undefined);
    }
    default:
      // A room with no page of its own yet. Plain text beats a dead link.
      return null;
  }
}

/** Split a stored path into its parts. Node paths use "/", movement-row snapshots
 *  use "›" — sniffed rather than configured, because the two come from different
 *  writers and a caller should not have to know which one it holds. */
function splitPath(path: string | null | undefined, separator?: string): string[] {
  if (!path) return [];
  const sep = separator ?? (path.includes('›') ? '›' : '/');
  return path
    .split(sep)
    .map((p) => p.trim())
    .filter(Boolean);
}

interface Props {
  /** Full path, when the caller has one — a stored snapshot beats a live lookup
   *  for anything historical: a ledger row must keep saying where stock came from
   *  after that shelf is renamed or removed. */
  path?: string | null;
  /** The node to open, and the fallback source of the hierarchy. Without it the
   *  leaf still renders and still hovers; it just does not link. */
  nodeId?: string | null;
  /** Display text, when the caller already holds the leaf name. Falls back to the
   *  last segment of ``path``, then to the node's name in the forest. */
  name?: string | null;
  /** State of the kit this row belongs to, if any. Only affects a production
   *  floor, where it picks the tab that actually contains that kit. */
  kitStatus?: KitStatus | null;
  /** Separator used by the stored path, when sniffing would get it wrong. */
  separator?: string;
  className?: string;
  /** Called before navigating — for callers inside a clickable row. */
  onNavigate?: () => void;
}

export function LocationPath({
  path,
  nodeId,
  name,
  kitStatus,
  separator,
  className,
  onNavigate,
}: Props) {
  const forest = useLocationForest();

  // The hierarchy, preferring what the caller holds. The forest is the fallback,
  // not the source: it describes the tree as it is NOW, and half these call sites
  // are history.
  const parts = React.useMemo(() => {
    const fromPath = splitPath(path, separator);
    if (fromPath.length > 0) return fromPath;
    if (!forest || !nodeId) return [];
    return nodeChain(forest, nodeId)
      .filter((n: PNode) => !n.isGroup)
      .map((n: PNode) => n.name);
  }, [path, separator, forest, nodeId]);

  const leaf = name ?? parts.at(-1) ?? null;

  const href = React.useMemo(() => {
    if (!forest || !nodeId) return null;
    return locationHref(forest, nodeId, kitStatus);
  }, [forest, nodeId, kitStatus]);

  if (!leaf) {
    return <span className="text-text-3">—</span>;
  }

  // Nothing to reveal — showing a hover affordance that opens a one-line tooltip
  // repeating the visible text is a promise the UI does not keep. The native
  // title stays as the only hint there is.
  const hasHierarchy = parts.length > 1;

  const trigger = href ? (
    <Link
      href={href}
      // Several call sites sit inside rows and cells that have their own click
      // handler.
      onClick={(e) => {
        e.stopPropagation();
        onNavigate?.();
      }}
      // No native title when the rich panel renders: the browser would draw its
      // own grey bubble over the top of it, which is the exact inconsistency this
      // component exists to remove.
      title={hasHierarchy ? undefined : `Open ${leaf}`}
      className={cn(
        'inline-flex max-w-full items-center gap-1 truncate rounded-sm text-accent underline-offset-2 transition-opacity hover:underline hover:opacity-80',
        className,
      )}
    >
      <span className="truncate">{leaf}</span>
    </Link>
  ) : hasHierarchy ? (
    <button
      type="button"
      className={cn(
        'inline-flex max-w-full items-center gap-1 truncate text-left underline decoration-dotted decoration-text-3 underline-offset-4 hover:decoration-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
        className,
      )}
    >
      <MapPin size={11} className="shrink-0 text-text-3" />
      <span className="truncate">{leaf}</span>
    </button>
  ) : (
    <span className={cn('truncate', className)} title={leaf}>
      {leaf}
    </span>
  );

  if (!hasHierarchy) return trigger;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      {/* Overrides the default tooltip skin, which is INVERTED (`bg-text` with
          `text-bg`) for one-line hints. This is a structured panel, not a hint:
          on that dark ground the leaf — styled as primary ink — rendered dark on
          dark and simply vanished, leaving an arrow pointing at nothing. A
          surface ground keeps the app's normal text hierarchy meaningful, which
          is what lets the leaf read as the emphasised row. */}
      <TooltipContent
        side="top"
        align="start"
        className="max-w-xs border-border bg-bg-elev p-0 text-text shadow-elev-sm"
      >
        <div className="px-3 py-2">
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-text-3">
            Location
          </p>
          <ol className="space-y-0.5">
            {parts.map((part, i) => {
              const isLeaf = i === parts.length - 1;
              return (
                <li
                  key={`${part}-${i}`}
                  className="flex items-center gap-1.5 whitespace-nowrap text-xs"
                  style={{ paddingLeft: i * 12 }}
                >
                  {i > 0 && (
                    <CornerDownRight size={11} className="shrink-0 text-text-3" aria-hidden />
                  )}
                  <span className={isLeaf ? 'font-medium text-text' : 'text-text-2'}>{part}</span>
                </li>
              );
            })}
          </ol>
          {href && <p className="mt-1.5 text-[10px] text-text-3">Click to open</p>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
