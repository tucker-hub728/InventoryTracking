'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, ChevronRight, Info } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useNotificationsStore } from '@/stores/notifications.store';
import { notificationsApi } from '@/lib/api/notifications';
import { toView } from '@/lib/notification-view';
import { cn } from '@/lib/utils';
import type { Notification, NotificationView } from '@/types/notification';
import type { BadgeTone } from '@/types/ui';

const ICON_MAP: Record<NotificationView['icon'], LucideIcon> = {
  warn: AlertTriangle,
  info: Info,
  check: Check,
};

const TONE_CLASS: Record<BadgeTone, { bg: string; fg: string }> = {
  neutral: { bg: 'bg-surface-2', fg: 'text-text-2' },
  accent: { bg: 'bg-accent-soft', fg: 'text-accent' },
  success: { bg: 'bg-success-soft', fg: 'text-success' },
  warning: { bg: 'bg-warning-soft', fg: 'text-warning' },
  danger: { bg: 'bg-danger-soft', fg: 'text-danger' },
};

type Tab = 'unread' | 'read';

/**
 * The bell's contents.
 *
 * Two tabs, because "Mark all as read" used to be a one-way door: the rows were
 * still there, still true, and there was no screen anywhere that could show
 * them again. Unread is fed live by the SSE stream; Read is fetched on demand,
 * since history does not change under you and does not need a subscription.
 *
 * Selecting a row marks it read and navigates to wherever the thing it is
 * complaining about can be dealt with — the item's page for a stock alert, the
 * expiry register for a consumable.
 *
 * The EMAIL and SMS chips that used to sit in this header are gone; they
 * toggled a boolean nothing read, and nothing in this application sends either.
 */
export function NotificationsPanel({
  total,
  onNavigate,
}: {
  total: number;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const unreadItems = useNotificationsStore((s) => s.items);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const markRead = useNotificationsStore((s) => s.markRead);

  const [tab, setTab] = React.useState<Tab>('unread');
  const [readItems, setReadItems] = React.useState<Notification[] | null>(null);
  const [loadingRead, setLoadingRead] = React.useState(false);

  // Fetched when the tab is first opened, and again whenever the unread list
  // changes — marking something read moves it from one tab to the other, so a
  // cached Read list would be missing whatever you just clicked.
  React.useEffect(() => {
    if (tab !== 'read') return;
    const ctrl = new AbortController();
    setLoadingRead(true);
    notificationsApi
      .list({ status: 'read', limit: 50 }, { signal: ctrl.signal })
      .then((res) => setReadItems(res.items))
      .catch(() => setReadItems([]))
      .finally(() => setLoadingRead(false));
    return () => ctrl.abort();
  }, [tab, unreadItems.length]);

  const views = React.useMemo(
    () => (tab === 'unread' ? unreadItems : (readItems ?? [])).map(toView),
    [tab, unreadItems, readItems],
  );

  const select = React.useCallback(
    (n: NotificationView) => {
      // Mark first so the badge settles even if the route is slow. Already-read
      // rows skip it — re-posting would be a no-op the server has to answer.
      if (!n.isRead) void markRead(n.id);
      if (n.href) {
        onNavigate?.();
        router.push(n.href);
      }
    },
    [markRead, onNavigate, router],
  );

  return (
    <div className="flex max-h-[520px] flex-col overflow-hidden rounded-md">
      <div className="flex items-center justify-between border-b border-border px-3.5 py-3">
        <div className="text-sm font-semibold">Notifications</div>
        <div className="flex items-center gap-1" role="tablist" aria-label="Notification status">
          <TabButton active={tab === 'unread'} onClick={() => setTab('unread')}>
            Unread{total > 0 && ` (${total})`}
          </TabButton>
          <TabButton active={tab === 'read'} onClick={() => setTab('read')}>
            Read
          </TabButton>
        </div>
      </div>

      <ul className="max-h-[380px] overflow-y-auto">
        {tab === 'read' && loadingRead && readItems === null && (
          <li className="px-3.5 py-8 text-center text-xs text-text-3">Loading…</li>
        )}
        {views.length === 0 && !(tab === 'read' && readItems === null) && (
          <li className="px-3.5 py-8 text-center text-xs text-text-3">
            {tab === 'unread' ? 'No notifications' : 'Nothing read yet'}
          </li>
        )}
        {views.map((n) => {
          const Icon = ICON_MAP[n.icon];
          const tone = TONE_CLASS[n.tone];
          return (
            <li key={n.id} className="border-t border-border first:border-t-0">
              {/* A button, not a div with onClick: these are navigations, so
                  they must be reachable by keyboard and announced as actions. */}
              <button
                type="button"
                onClick={() => select(n)}
                className={cn(
                  'flex w-full gap-2.5 px-3.5 py-3 text-left transition-colors hover:bg-surface focus-visible:bg-surface focus-visible:outline-none',
                  n.isRead && 'opacity-70',
                )}
              >
                <div
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-full',
                    tone.bg,
                    tone.fg,
                  )}
                  aria-hidden
                >
                  <Icon size={13} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="truncate text-sm font-medium">{n.title}</div>
                    <div className="shrink-0 text-[11px] text-text-3">{n.ts}</div>
                  </div>
                  <div className="mt-0.5 text-xs leading-snug text-text-2">{n.body}</div>
                </div>
                {n.href && (
                  <ChevronRight
                    size={14}
                    className="mt-0.5 shrink-0 self-center text-text-3"
                    aria-hidden
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-between border-t border-border bg-surface px-3.5 py-2 text-xs">
        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={total === 0}
          className="text-text-2 transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          Mark all as read
        </button>
        {/* The server's own unread count, not `views.length` — the panel shows a
            capped head of the feed, so counting what is rendered would report
            the cap as the total, which is what the old bell did. It also has to
            stay the UNREAD count while the Read tab is open. */}
        <span className="text-text-3">{total} unread</span>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors',
        active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-text-3 hover:bg-surface',
      )}
    >
      {children}
    </button>
  );
}
