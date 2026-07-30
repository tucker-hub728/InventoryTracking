/**
 * The Materials Management page's tabs.
 *
 * REQ-2026-07-15-LOC-005 makes Materials Management a location category holding
 * two peer locations — Warehouse One (ambient) and the Cold Storage groups — so
 * they are tabs of one page rather than two entries in the sidebar.
 *
 * Deliberately a PLAIN module with no ``'use client'``: the route files are
 * server components and read ``MM_TAB_SEGMENTS`` to validate the segment.
 * Exporting these from the client component instead hands the server a client
 * *reference* rather than the real array, and calling ``.includes()`` on it
 * throws at request time (which a build never catches). Same reasoning as
 * ``components/production/floor-tabs.ts``.
 */
/**
 * The Materials Management room's node code, as seeded by
 * ``backend/scripts/seed_materials_management.py``.
 *
 * ``/location-nodes/freezer-tree`` returns EVERY room (Cold Storage and
 * Analytical Lab are rooms too), so this page has to name the one it is, rather
 * than take the first room off the list.
 */
export const MM_ROOM_CODE = 'MM';

/**
 * The room's Minus-20 Freezers location, as seeded.
 *
 * The second tab IS this location, so the tab resolves it by code and renders its
 * units directly. Anything else that turns up as a location in this room is an
 * anomaly — LOC-005 allows exactly two — and the page says so rather than
 * quietly drawing it as though it belonged.
 */
export const MM_FREEZER_LOCATION_CODE = 'MM-F20';

/**
 * The second tab is labelled for what it actually holds, not for the category it
 * belongs to. "Cold Storage" now names a room of its own (LOC-002), and using
 * the same word for this tab meant two different things in the sidebar and the
 * page carried one name. LOC-005 calls this location "Minus-20 Freezers", so
 * that is what it says.
 *
 * The route segment stays ``cold-storage`` — existing links and bookmarks point
 * at it, and a segment rename would break them for no gain.
 */
export const MM_TABS: readonly { seg: string; label: string }[] = [
  // Both labels are LOC-005's own words — "Warehouse One" and "Minus-20
  // Freezers" are what the requirement calls the room's two peer locations, so
  // the UI says exactly that rather than a shortened form.
  { seg: 'warehouse', label: 'Warehouse One' },
  { seg: 'cold-storage', label: 'Minus-20 Freezers' },
];

export const MM_TAB_SEGMENTS: readonly string[] = MM_TABS.map((t) => t.seg);

export const DEFAULT_MM_TAB = MM_TABS[0]!.seg;

/** Route for a tab, optionally deep-linked to a node's contents. */
export function mmHref(tab: string, nodeId?: string): string {
  return `/materials-management/${tab}${nodeId ? `/${nodeId}` : ''}`;
}
