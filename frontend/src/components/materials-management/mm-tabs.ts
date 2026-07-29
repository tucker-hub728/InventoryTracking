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
export const MM_TABS: readonly { seg: string; label: string }[] = [
  { seg: 'warehouse', label: 'Warehouse' },
  { seg: 'cold-storage', label: 'Cold Storage' },
];

export const MM_TAB_SEGMENTS: readonly string[] = MM_TABS.map((t) => t.seg);

export const DEFAULT_MM_TAB = MM_TABS[0]!.seg;

/** Route for a tab, optionally deep-linked to a node's contents. */
export function mmHref(tab: string, nodeId?: string): string {
  return `/materials-management/${tab}${nodeId ? `/${nodeId}` : ''}`;
}
