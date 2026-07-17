'use client';

import * as React from 'react';

/** How long a loading state stays on screen once it has appeared (ms). */
export const MIN_LOADING_MS = 350;

/**
 * Hold a loading flag true for a minimum duration.
 *
 * These panels answer in ~20–60ms locally, so a raw ``loading`` flag paints the
 * skeleton for two or three frames and disappears — the eye reads it as a flash,
 * or as nothing at all. Holding it briefly makes the fetch legible instead of
 * having content appear from nowhere.
 *
 * The cost is real: a fetch that finishes in 20ms still shows the skeleton for
 * ``ms``. That is the deliberate trade — perceptible feedback over raw speed on
 * a fast connection. On a slow one the fetch already exceeds the floor and this
 * hook does nothing.
 *
 * @param active  the underlying "is fetching" flag
 * @param ms      minimum time to keep it true once it goes true
 */
export function useMinDuration(active: boolean, ms: number = MIN_LOADING_MS): boolean {
  const [held, setHeld] = React.useState(active);
  const startedAt = React.useRef<number | null>(active ? Date.now() : null);

  React.useEffect(() => {
    if (active) {
      // Stamp the start once per burst, so a re-render mid-flight doesn't
      // keep pushing the deadline out.
      startedAt.current ??= Date.now();
      setHeld(true);
      return;
    }
    if (startedAt.current === null) {
      setHeld(false);
      return;
    }
    const remaining = ms - (Date.now() - startedAt.current);
    startedAt.current = null;
    if (remaining <= 0) {
      setHeld(false);
      return;
    }
    const t = setTimeout(() => setHeld(false), remaining);
    return () => clearTimeout(t);
  }, [active, ms]);

  return held;
}
