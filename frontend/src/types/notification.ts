import type { BadgeTone } from './ui';

/**
 * Kinds, mirroring `NOTIFICATION_KINDS` in the backend model and its DB CHECK.
 *
 * The old client-side union (`'low' | 'expire' | 'info' | 'audit'`) is gone.
 * Two of its members were never produced by anything, and the other two were
 * invented in the browser because there was no server-side notion of a
 * notification at all.
 */
export type NotificationKind =
  | 'reorder_threshold'
  | 'expiration_warning'
  | 'expiration_expired';

export type NotificationSubjectTable = 'app.items' | 'app.consumable_issues';

/** Body of a `reorder_threshold` notification. Facts only — see below. */
export interface ReorderNotificationBody {
  status_code: 'low_stock' | 'out_of_stock';
  item_id: string;
  item_number: string;
  description: string;
  uom: string;
  qty_available: string;
  reorder_threshold: string;
  lead_time_days: number | null;
}

/** Body of an `expiration_*` notification. */
export interface ExpiryNotificationBody {
  flag: 'warn' | 'expired';
  issue_id: string;
  item_id: string;
  item_number: string;
  item_description: string | null;
  lot_number: string | null;
  expiration_date: string | null;
  days_to_expiry: number | null;
}

/**
 * One notification, exactly as the server stores it.
 *
 * `body` carries facts and never a rendered label or colour. The badge tone and
 * wording for a stock status come from `STOCK_STATUS_META` in
 * `config/inventory.ts` and from nowhere else — that is the single-source rule
 * that stopped "Out of stock" rendering in three colours at once, and a
 * server-supplied label would quietly become a fourth source.
 */
export interface Notification {
  id: string;
  kind_code: NotificationKind;
  subject_table: NotificationSubjectTable;
  subject_id: string;
  body: ReorderNotificationBody | ExpiryNotificationBody | Record<string, unknown>;
  created_at: string;
  read_at: string | null;
  dismissed_at: string | null;
  resolved_at: string | null;
}

/** What the SSE `snapshot` event carries, and what `GET /notifications` returns. */
export interface NotificationFeed {
  items: Notification[];
  unread_count: number;
}

/** Presentation derived from a notification. Resolved on the client, always. */
export interface NotificationView {
  id: string;
  title: string;
  body: string;
  tone: BadgeTone;
  icon: 'warn' | 'info' | 'check';
  ts: string;
  itemId?: string;
  /**
   * Where selecting this notification takes you — the screen where the thing it
   * is complaining about can actually be dealt with.
   *
   * Derived on the client rather than stored on the row: a route is a fact
   * about this application's URL structure, and baking one into a database row
   * would leave every historical notification pointing at a path that a later
   * reorganisation had moved.
   */
  href?: string;
  isRead: boolean;
}
