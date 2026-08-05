'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Navigation shortcuts for a room's location list (REQ-2026-07-15-UI-002:
 * "shelves and key targets shall not sit far below the fold for a new
 * operator; navigation shortcuts shall be added where needed").
 *
 * The case that forced this is Materials Management: REQ-2026-07-15-LOC-005
 * gives Warehouse One Shelf A through Shelf Z, so 26 cards stand between the
 * top of the page and the Minus-20 Freezers group below them. A new operator
 * scrolls past everything to find out the second group exists.
 */

/** Anchor id for a group heading, so a chip can scroll to it. */
export const groupAnchorId = (locationId: string) => `loc-group-${locationId}`;

/** Anchor id for one storage leaf, so the letter rail can scroll to it. */
export const leafAnchorId = (leafId: string) => `loc-leaf-${leafId}`;

/** Scroll an anchor into view, allowing for the sticky toolbar above it. */
function scrollToAnchor(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 120;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

/**
 * Roughly a screenful of cards: four columns by three rows at the desktop
 * grid. Below this everything is visible at once, so nothing is "far below the
 * fold" and there is nothing to jump to.
 */
const CROWDED_ENOUGH_TO_NEED_JUMPS = 12;

/** One chip per group — the "what else is on this page" answer. */
export function GroupJumpChips({
  groups,
}: {
  groups: { id: string; name: string; count: number }[];
}) {
  // UI-002 asks for shortcuts "where needed", and the need it describes is a
  // later group pushed below the fold by a long one above it — Warehouse One's
  // Shelf A–Z (LOC-005) is the case that prompted it. A room with two groups of
  // three units has no such problem, and a jump bar over content already fully
  // on screen is clutter the requirement never asked for.
  const total = groups.reduce((sum, g) => sum + g.count, 0);
  if (groups.length < 2 || total < CROWDED_ENOUGH_TO_NEED_JUMPS) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wider text-text-3">Jump to</span>
      {groups.map((g) => (
        <button
          key={g.id}
          type="button"
          onClick={() => scrollToAnchor(groupAnchorId(g.id))}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-elev px-2.5 py-1 text-xs text-text-2 transition-colors hover:border-accent/50 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {g.name}
          <span className="font-mono text-[10px] text-text-3">{g.count}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A–Z rail over a group's leaves. Each letter is enabled only when something in
 * the group starts with it, so the rail also reads as a map of what is there —
 * a warehouse lettered A–Z lights up completely, a freezer bank of T-numbers
 * lights up one letter and is therefore not shown at all.
 */
export function LetterRail({ leaves }: { leaves: { id: string; name: string }[] }) {
  const firstIdByLetter = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const leaf of leaves) {
      // "Shelf C" → C. The letter that matters is the one that distinguishes
      // the leaves, which is the last word's initial, not the shared prefix.
      const word = leaf.name.trim().split(/\s+/).pop() ?? '';
      const letter = word.charAt(0).toUpperCase();
      if (/[A-Z]/.test(letter) && !map.has(letter)) map.set(letter, leaf.id);
    }
    return map;
  }, [leaves]);

  // Under a handful of letters the rail is longer than the list it indexes.
  if (firstIdByLetter.size < 6) return null;

  return (
    <div className="flex flex-wrap items-center gap-0.5" aria-label="Jump to letter">
      {Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).map((letter) => {
        const target = firstIdByLetter.get(letter);
        return (
          <button
            key={letter}
            type="button"
            disabled={!target}
            aria-disabled={!target}
            onClick={() => target && scrollToAnchor(leafAnchorId(target))}
            className={cn(
              'size-5 rounded text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              target
                ? 'text-text-2 hover:bg-surface-2 hover:text-accent'
                : 'cursor-default text-text-3/40',
            )}
          >
            {letter}
          </button>
        );
      })}
    </div>
  );
}
