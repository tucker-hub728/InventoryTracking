'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

import { STOCK_STATUS_META } from '@/config/inventory';
import { consumablesApi } from '@/lib/api/consumables';
import { planningApi } from '@/lib/api/planning';
import { useNotificationsStore } from '@/stores/notifications.store';
import type { Notification } from '@/types/notification';

/** How many of each kind the bell carries. The panel is a prompt to open the
 *  full screen, not a replacement for it — an unbounded list in a popover is
 *  unreadable, and both feeds have a page of their own that shows everything. */
const PER_KIND = 5;

/**
 * Hydrates the notifications store from the live API.
 *
 * Two real sources, both already paged and ordered by urgency on the server,
 * so this takes the first few of each and does no sorting of its own:
 *
 *  * **Low stock** — `/planning/reorder` (PLN-001). Ordered out-of-stock
 *    first, then longest supplier lead time, so the items the bell shows are
 *    the ones where a late order costs the most.
 *  * **Expiring** — `/consumables/expiring` (LOC-008). Ordered
 *    earliest-expiry-first.
 *
 * Refreshed on mount and on route change, matching `useNavCounts`. No polling,
 * for the same reason: these numbers move when someone acts, not on a clock,
 * and a timer on every open tab is a lot of traffic to keep a bell warm.
 *
 * A failed fetch yields no notifications of that kind rather than throwing —
 * the bell is an aid, and it must not take the topbar down with it. The two
 * calls are settled independently so one failing still leaves the other's rows.
 */
export function useNotificationsFeed(): void {
  const setItems = useNotificationsStore((s) => s.setItems);
  const pathname = usePathname();
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    feedListeners.add(refresh);
    return () => {
      feedListeners.delete(refresh);
    };
  }, [refresh]);

  useEffect(() => {
    const ctrl = new AbortController();

    void (async () => {
      const [reorder, expiring] = await Promise.allSettled([
        planningApi.reorder({ limit: PER_KIND, offset: 0 }, { signal: ctrl.signal }),
        consumablesApi.expiring({ limit: PER_KIND, offset: 0 }, { signal: ctrl.signal }),
      ]);
      if (ctrl.signal.aborted) return;

      const out: Notification[] = [];

      if (reorder.status === 'fulfilled') {
        for (const r of reorder.value.items) {
          // Label AND colour from the shared config, so a bell entry cannot
          // describe an item differently from the row it links to.
          const meta = STOCK_STATUS_META[r.status_code];
          out.push({
            id: `low-${r.item_id}`,
            kind: 'low',
            icon: 'warn',
            tone: meta.tone,
            title: meta.label,
            body: bodyForReorder(r),
            itemId: r.item_id,
            // The API gives no "when" for a threshold breach — it is a state
            // derived on read, not an event with a timestamp.
            ts: 'Now',
          });
        }
      }

      if (expiring.status === 'fulfilled') {
        for (const e of expiring.value.items) {
          out.push({
            id: `exp-${e.id}`,
            kind: 'expire',
            icon: 'warn',
            tone: e.flag === 'expired' ? 'danger' : 'warning',
            title: e.flag === 'expired' ? 'Expired' : 'Expiring soon',
            body: bodyForExpiry(e),
            itemId: e.item_id,
            ts: new Date(e.issued_at).toLocaleDateString(),
          });
        }
      }

      setItems(out);
    })();

    return () => ctrl.abort();
  }, [setItems, pathname, tick]);
}

/** Tell every mounted feed to re-read. Mirrors `refreshNavCounts` — fire it
 *  from whatever just changed the underlying data. */
const feedListeners = new Set<() => void>();
export function refreshNotificationsFeed(): void {
  for (const l of feedListeners) l();
}

function bodyForReorder(r: {
  description: string;
  item_number: string;
  qty_available: string;
  reorder_threshold: string;
  uom: string;
  lead_time_days: number | null;
}): string {
  const unit = r.uom ? ` ${r.uom}` : '';
  const head = `${r.description} (${r.item_number}) is at ${num(r.qty_available)}${unit} — threshold ${num(r.reorder_threshold)}${unit}.`;
  // The lead time is the actionable half: it says how long you have. Omitted
  // rather than guessed at when no supplier has one recorded.
  return r.lead_time_days === null
    ? `${head} No supplier lead time recorded.`
    : `${head} Longest supplier lead time is ${r.lead_time_days} days.`;
}

function bodyForExpiry(e: {
  item_description: string | null;
  item_number: string;
  lot_number: string | null;
  expiration_date: string | null;
  days_to_expiry: number | null;
  flag: string | null;
}): string {
  const what = e.item_description ?? e.item_number;
  const lot = e.lot_number ? ` (Lot ${e.lot_number})` : '';
  const when = e.expiration_date ? new Date(e.expiration_date).toLocaleDateString() : 'an unknown date';
  return e.flag === 'expired'
    ? `${what}${lot} expired ${when} and needs a physical check.`
    : `${what}${lot} expires ${when}${e.days_to_expiry === null ? '' : ` — ${e.days_to_expiry} days left`}.`;
}

/** NUMERIC arrives as a string; trim the stored decimal places for display. */
function num(s: string): string {
  const v = Number(s);
  return Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : s;
}
