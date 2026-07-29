import type { FloorSection } from '@/lib/api/kits';

/**
 * The production floor page's tabs — URL segment ⇄ API section.
 *
 * Deliberately a PLAIN module with no ``'use client'``: the route file is a
 * server component and reads ``FLOOR_TAB_SEGMENTS`` to validate the segment.
 * Exporting these from the client component instead hands the server a client
 * *reference* rather than the real array, and calling ``.includes()`` on it
 * throws "Attempted to call includes() from the server but includes is on the
 * client" at request time (which a build never catches).
 *
 * The segment is what shows in the address bar, so it stays hyphenated and
 * readable; the section is what the API expects.
 */
export const FLOOR_TABS: readonly { seg: string; section: FloorSection; label: string }[] = [
  { seg: 'in-production', section: 'in_production', label: 'In production' },
  // "Closed" — not "Consumed": these are kits whose status is closed, which is
  // the badge shown on the cards inside and the SRS's own close-out language
  // (client 2026-07-28). All three tabs read as kit states.
  { seg: 'closed', section: 'closed', label: 'Closed' },
  { seg: 'cancelled', section: 'cancelled', label: 'Cancelled' },
];

export const FLOOR_TAB_SEGMENTS: readonly string[] = FLOOR_TABS.map((t) => t.seg);

export const DEFAULT_FLOOR_TAB = FLOOR_TABS[0]!.seg;
