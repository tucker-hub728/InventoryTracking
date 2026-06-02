'use client';

import { create } from 'zustand';

import type { Notification } from '@/types/notification';

interface NotificationsState {
  items: Notification[];
  read: Set<string>;
  emailDelivery: boolean;
  smsDelivery: boolean;

  setItems: (items: Notification[]) => void;
  markAllRead: () => void;
  markRead: (id: string) => void;
  toggleEmail: () => void;
  toggleSms: () => void;
}

export const useNotificationsStore = create<NotificationsState>((set) => ({
  items: [],
  read: new Set<string>(),
  emailDelivery: true,
  smsDelivery: false,

  setItems: (items) => set({ items }),
  markAllRead: () =>
    set((s) => ({ read: new Set(s.items.map((i) => i.id)) })),
  markRead: (id) =>
    set((s) => {
      const next = new Set(s.read);
      next.add(id);
      return { read: next };
    }),
  toggleEmail: () => set((s) => ({ emailDelivery: !s.emailDelivery })),
  toggleSms: () => set((s) => ({ smsDelivery: !s.smsDelivery })),
}));

export const selectUnreadCount = (s: NotificationsState) =>
  s.items.filter((i) => !s.read.has(i.id)).length;
