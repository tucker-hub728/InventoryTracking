'use client';

/**
 * A location name that navigates to the page that location lives on.
 *
 * Every storage area now has a route, but they are not one route — which page a
 * node belongs to depends on where it hangs, so the href is derived from the
 * node's ancestry rather than from the node itself:
 *
 *   Materials Management  →  /materials-management/{warehouse|cold-storage}/{id}
 *   Cold Storage          →  /cold-storage/{id}
 *   Analytical Lab        →  /analytical-lab/{id}
 *   LN2                   →  /ln2/{tank}/{quadrant}/{rack}/{box}
 *   Production            →  /production/{id}
 *
 * The ancestry comes from the shared location forest, which is already cached
 * for the destination pickers — so a ledger with fifty rows costs no extra
 * requests. Until it loads, and for any node the forest doesn't contain, the
 * label renders as plain text: a link that cannot resolve is worse than no link.
 *
 * Note LN2 wants the whole chain of ids, not just the leaf. Only the last
 * segment drives selection; the ancestors are there so the URL reads as the
 * physical address and a shared link says where in the tank to look.
 */

import * as React from 'react';
import Link from 'next/link';

import {
  MM_ROOM_CODE,
  mmHref,
} from '@/components/materials-management/mm-tabs';
import { DEFAULT_FLOOR_TAB, FLOOR_TABS } from '@/components/production/floor-tabs';
import {
  ANALYTICAL_LAB_ROOM,
  COLD_STORAGE_ROOM,
} from '@/components/rooms/room-config';
import type { KitStatus } from '@/lib/api/kits';
import {
  nodeChain,
  useLocationForest,
  type Forest,
  type PNode,
} from '@/components/reconciliation/location-tree-picker';
import { cn } from '@/lib/utils';

/** The synthetic LN2 group's id, from the forest builder. */
const LN2_GROUP_ID = 'grp:ln2';

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
/** The floor tab that lists a room's Kanban stations. Derived, not hard-coded,
 *  so renaming the segment in one place stays enough. */
const KANBAN_TAB = FLOOR_TABS.find((t) => t.kind === 'kanban')?.seg ?? 'kanban';

function floorTabFor(status: KitStatus): string {
  const section =
    status === 'closed' ? 'closed' : status === 'cancelled' ? 'cancelled' : 'in_production';
  // Only the kit-state tabs are addressable by section; the Kanban tab is a
  // stock view and no kit ever links to it.
  return (
    FLOOR_TABS.find((t) => t.kind === 'kits' && t.section === section)?.seg ?? DEFAULT_FLOOR_TAB
  );
}

/** Route for a node, or null when it has no page to open. */
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

  // A Kanban has no page of its own — it is a station INSIDE a production
  // area, listed on that area's Kanban tab (LOC-006 / consum01). Checked before
  // the production branch below, which would otherwise build
  // `/production/{kanbanId}` and open a floor page for an id that is not a
  // floor.
  if (node.nodeType === 'kanban') {
    const area = chain.filter((n) => !n.isGroup).at(-2);
    return area ? `/production/${area.id}/${KANBAN_TAB}` : null;
  }

  // A production floor is its own page, whatever else is true of it — opened at
  // the tab that actually contains the kit, when the caller knows which.
  if (node.area === 'production') {
    return kitStatus
      ? `/production/${node.id}/${floorTabFor(kitStatus)}`
      : `/production/${node.id}`;
  }

  if (root.id === LN2_GROUP_ID) {
    const ids = chain.filter((n) => !n.isGroup).map((n) => n.id);
    return ids.length > 0 ? `/ln2/${ids.join('/')}` : null;
  }

  switch (root.code) {
    case MM_ROOM_CODE:
      // The room's two locations are tabs, and a warehouse anywhere in the
      // ancestry means this is a shelf rather than a freezer unit.
      return mmHref(
        chain.some((n) => n.nodeType === 'warehouse') ? 'warehouse' : 'cold-storage',
        node.id,
      );
    case COLD_STORAGE_ROOM.code:
      return `${COLD_STORAGE_ROOM.href}/${node.id}`;
    case ANALYTICAL_LAB_ROOM.code:
      return `${ANALYTICAL_LAB_ROOM.href}/${node.id}`;
    default:
      // A room with no page of its own yet. Plain text beats a dead link.
      return null;
  }
}

/** The breadcrumb for a node, for a tooltip — "Materials Management › Shelf A". */
function chainLabel(chain: PNode[]): string | null {
  const real = chain.filter((n) => !n.isGroup);
  return real.length > 0 ? real.map((n) => n.name).join(' › ') : null;
}

export function LocationLink({
  nodeId,
  name,
  path,
  kitStatus,
  className,
  onNavigate,
}: {
  /** The node to open. Plain text is rendered when absent or unresolvable. */
  nodeId: string | null | undefined;
  /** Display text — the node's name as the caller already has it. */
  name: string | null | undefined;
  /** Breadcrumb for the tooltip. Falls back to one derived from the forest. */
  path?: string | null;
  /** State of the kit this row belongs to, if any. Only affects a production
   *  floor, where it picks the tab that actually contains that kit. */
  kitStatus?: KitStatus | null;
  className?: string;
  /** Called before navigating — for callers inside a clickable row. */
  onNavigate?: () => void;
}) {
  const forest = useLocationForest();
  const label = name ?? '—';

  const resolved = React.useMemo(() => {
    if (!forest || !nodeId) return null;
    const href = locationHref(forest, nodeId, kitStatus);
    return href ? { href, title: path ?? chainLabel(nodeChain(forest, nodeId)) } : null;
  }, [forest, nodeId, path, kitStatus]);

  if (!resolved) {
    return (
      <span className={className} title={path ?? undefined}>
        {label}
      </span>
    );
  }

  return (
    <Link
      href={resolved.href}
      title={resolved.title ? `Open ${resolved.title}` : `Open ${label}`}
      // Several call sites sit inside clickable rows and cells.
      onClick={(e) => {
        e.stopPropagation();
        onNavigate?.();
      }}
      className={cn(
        'text-accent underline-offset-2 transition-opacity hover:underline hover:opacity-80',
        className,
      )}
    >
      {label}
    </Link>
  );
}
