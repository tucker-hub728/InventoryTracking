/**
 * Freeze a table's first column while the rest scrolls sideways
 * (REQ-2026-07-15-UI-001).
 *
 * The wide lists don't fit an iPad: the inventory table is 1080px against
 * 708px of content width in portrait. Horizontal scrolling is the honest answer
 * — the columns carry real information and hiding them by width would quietly
 * change what the list says. What makes it *navigable* is keeping the
 * identifying column in place, so a row scrolled halfway across still tells you
 * which item you are reading.
 *
 * The Planning grid already froze its first column this way; this lifts that
 * into something the other tables can share rather than re-deriving.
 *
 * Both classes need an opaque background — the scrolled cells pass *underneath*
 * the frozen one, and a transparent cell would show them through. ``bg-surface``
 * matches ``TableHead``; ``bg-bg-elev`` matches the Card the tables sit in.
 *
 * Usage — apply to the first cell of every row, header included:
 *
 *     <TableHead className={STICKY_HEAD}>Item #</TableHead>
 *     <TableCell className={STICKY_CELL}>{item.id}</TableCell>
 */

/** First header cell: sticky in both axes, so it holds the top-left corner. */
export const STICKY_HEAD =
  'sticky left-0 z-30 bg-surface after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border';

/** First body cell of each row. */
export const STICKY_CELL =
  'sticky left-0 z-20 bg-bg-elev after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border';
