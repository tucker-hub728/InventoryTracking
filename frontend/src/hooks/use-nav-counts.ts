'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';

import { consumablesApi } from '@/lib/api/consumables';
import type { NavBadgeKey } from '@/config/nav';

export type NavCounts = Partial<Record<NavBadgeKey, number>>;

/**
 * Live counts for the sidebar badges.
 *
 * Fetched with ``limit=1``: only ``total`` is used, so the page of rows is
 * dead weight — this is a COUNT query with one row of overhead, cheap enough
 * to run on navigation.
 *
 * Refreshed on three triggers, none of them a timer:
 *
 *  * mount — the first paint after a reload;
 *  * route change — the sidebar persists across navigations, so without this
 *    the number would go stale the moment you left the page that changed it;
 *  * :func:`refreshNavCounts` — fired by whatever just changed the underlying
 *    data (an acknowledgment), because waiting for the next navigation to
 *    correct a number the user just acted on reads as a bug.
 *
 * Polling was deliberately not used. An expiry count moves when someone acts,
 * not on a clock, and a background poll on every open tab is a lot of traffic
 * to keep one pill warm.
 */
const listeners = new Set<() => void>();

/** Tell every mounted sidebar to re-read its counts. */
export function refreshNavCounts(): void {
  for (const l of listeners) l();
}

export function useNavCounts(enabled: boolean): NavCounts {
  const pathname = usePathname();
  const [counts, setCounts] = React.useState<NavCounts>({});
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    consumablesApi
      .expiring({ limit: 1, offset: 0 }, { signal: ctrl.signal })
      .then((page) => setCounts((c) => ({ ...c, expiringConsumables: page.total })))
      // A badge is decoration: a failed count leaves the row bare rather than
      // breaking the navigation everything else depends on.
      .catch(() => {});
    return () => ctrl.abort();
  }, [enabled, pathname, tick]);

  return counts;
}
