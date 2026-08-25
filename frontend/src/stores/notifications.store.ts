'use client';

import { create } from 'zustand';

import { notificationsApi } from '@/lib/api/notifications';
import type { Notification } from '@/types/notification';

/**
 * The bell's client state.
 *
 * Two things that used to live here are gone:
 *
 * * **`emailDelivery` / `smsDelivery`.** They rendered as EMAIL and SMS chips
 *   in the panel and flipped a boolean nothing read. No code anywhere in this
 *   application has ever sent an email or an SMS. Removed at the client's
 *   request (2026-08-25) rather than left advertising a capability that does
 *   not exist.
 * * **`read: Set<string>`.** Read state was a `Set` in memory, so "Mark all as
 *   read" survived until the next refresh and no further. It now lives in
 *   `notification_deliveries.read_at`, per user, on the server.
 *
 * Not persisted, deliberately. There is nothing left worth persisting — every
 * field here is server state, and caching server state in `localStorage` is how
 * a bell ends up confidently displaying something that stopped being true days
 * ago.
 */
interface NotificationsState {
  items: Notification[];
  unreadCount: number;
  /** Whether the live stream is currently attached. Drives nothing today; it is
   *  here so a future "reconnecting…" hint has something to read. */
  connected: boolean;

  setFeed: (items: Notification[], unreadCount: number) => void;
  setConnected: (connected: boolean) => void;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  reset: () => void;
}

export const useNotificationsStore = create<NotificationsState>()((set, get) => ({
  items: [],
  unreadCount: 0,
  connected: false,

  setFeed: (items, unreadCount) => set({ items, unreadCount }),
  setConnected: (connected) => set({ connected }),

  markRead: async (id) => {
    // Optimistic: drop it locally first so the panel responds to the click, then
    // reconcile from the server's own count. The next stream snapshot corrects
    // this anyway, which is what makes guessing safe here.
    const before = get().items;
    set({
      items: before.filter((n) => n.id !== id),
      unreadCount: Math.max(0, get().unreadCount - 1),
    });
    try {
      const res = await notificationsApi.markRead(id);
      set({ unreadCount: res.unread_count });
    } catch {
      // Put it back. A row that silently vanished without being marked read
      // would be an alert the user never sees again.
      set({ items: before });
    }
  },

  markAllRead: async () => {
    const before = get().items;
    const beforeCount = get().unreadCount;
    set({ items: [], unreadCount: 0 });
    try {
      const res = await notificationsApi.markAllRead();
      set({ unreadCount: res.unread_count });
    } catch {
      set({ items: before, unreadCount: beforeCount });
    }
  },

  reset: () => set({ items: [], unreadCount: 0, connected: false }),
}));

export const selectUnreadCount = (s: NotificationsState) => s.unreadCount;
export const selectNotifications = (s: NotificationsState) => s.items;
