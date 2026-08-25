import { STOCK_STATUS_META } from '@/config/inventory';
import type {
  ExpiryNotificationBody,
  Notification,
  NotificationView,
  ReorderNotificationBody,
} from '@/types/notification';

/**
 * Turns a stored notification into something renderable.
 *
 * The important rule lives here: for a stock alert the **title and tone come
 * from `STOCK_STATUS_META`**, resolved from `body.status_code`. The server
 * never sends a label or a colour, and this is the only place that decides one.
 * That is the same single-source rule `StatusBadge` and `StockStatusBadge`
 * follow — it exists because "Out of stock" once rendered in three different
 * colours simultaneously, each picked at a different call site.
 */
export function toView(n: Notification): NotificationView {
  const isRead = n.read_at !== null;
  if (n.kind_code === 'reorder_threshold') {
    const body = n.body as ReorderNotificationBody;
    const meta = STOCK_STATUS_META[body.status_code];
    return {
      id: n.id,
      title: meta.label,
      body: reorderText(body),
      tone: meta.tone,
      icon: 'warn',
      ts: relativeTime(n.created_at),
      itemId: body.item_id,
      // Straight to the item, not to the reorder screen. The alert names one
      // item and the question it raises ("how much is left, who supplies it,
      // what is on order?") is answered on its detail page; the planning list
      // would make you find the row again.
      href: body.item_id ? `/inventory/${body.item_id}` : undefined,
      isRead,
    };
  }

  const body = n.body as ExpiryNotificationBody;
  const expired = n.kind_code === 'expiration_expired';
  return {
    id: n.id,
    title: expired ? 'Expired' : 'Expiring soon',
    body: expiryText(body, expired),
    tone: expired ? 'danger' : 'warning',
    icon: 'warn',
    ts: relativeTime(n.created_at),
    itemId: body.item_id,
    // The cross-Kanban expiry register — the screen where the flag is
    // acknowledged. An item page cannot clear an expiry check, so sending
    // somebody there would be sending them to the wrong place.
    href: '/consumables',
    isRead,
  };
}

function reorderText(b: ReorderNotificationBody): string {
  const unit = b.uom ? ` ${b.uom}` : '';
  const head = `${b.description} (${b.item_number}) is at ${num(b.qty_available)}${unit} — threshold ${num(b.reorder_threshold)}${unit}.`;
  // The lead time is the actionable half: it says how long you have. Omitted
  // rather than guessed at when no supplier has one recorded.
  return b.lead_time_days === null
    ? `${head} No supplier lead time recorded.`
    : `${head} Longest supplier lead time is ${b.lead_time_days} days.`;
}

function expiryText(b: ExpiryNotificationBody, expired: boolean): string {
  const what = b.item_description ?? b.item_number;
  const lot = b.lot_number ? ` (Lot ${b.lot_number})` : '';
  const when = b.expiration_date
    ? new Date(b.expiration_date).toLocaleDateString()
    : 'an unknown date';
  return expired
    ? `${what}${lot} expired ${when} and needs a physical check.`
    : `${what}${lot} expires ${when}${b.days_to_expiry === null ? '' : ` — ${b.days_to_expiry} days left`}.`;
}

/** NUMERIC arrives as a string; trim the stored decimal places for display. */
function num(s: string): string {
  const v = Number(s);
  return Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : s;
}

/**
 * A real relative timestamp.
 *
 * The old feed hardcoded "Now" on every low-stock row, because a threshold
 * breach was derived on read and genuinely had no "when". These rows are
 * events with a `created_at`, so the panel can finally say when it happened.
 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'Now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
