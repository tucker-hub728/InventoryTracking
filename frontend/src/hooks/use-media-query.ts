'use client';

import * as React from 'react';

/**
 * Track a CSS media query from React (REQ-2026-07-15-UI-001).
 *
 * Layout itself is done in CSS — breakpoint classes, not measured coordinates
 * (see the note on UI-001 in the traceability matrix). This hook exists only
 * for the handful of places where the difference is *structural* rather than
 * stylistic and CSS cannot express it: an icon-only nav row wraps its link in a
 * tooltip and renders a smaller glyph, which is a different element tree, not a
 * different class.
 *
 * Returns ``false`` until mounted, so the server and the first client render
 * agree (no hydration mismatch) and the widest layout is what gets painted
 * first. Callers therefore see one extra render on a narrow screen.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Tailwind's `lg` — below this the sidebar is an overlay drawer rather than a
 *  column, so an iPad in portrait (744–834px) isn't paying 220px for it. */
export const BELOW_LG = '(max-width: 1023px)';

/** Below Tailwind's `xl`. An iPad in landscape (1024–1194px) has the room for a
 *  nav column but not for a 220px one beside a table, so the rail is forced to
 *  icons there and the operator's own preference only applies from 1280 up. */
export const BELOW_XL = '(max-width: 1279px)';
