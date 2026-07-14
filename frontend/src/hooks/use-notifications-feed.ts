'use client';

import { useEffect, useMemo } from 'react';

import { mockData } from '@/lib/mock-data';
import { useNotificationsStore } from '@/stores/notifications.store';
import type { Notification } from '@/types/notification';

/**
 * Hydrates the notifications store from current mock data.
 * In a real app this would subscribe to a server event stream or
 * poll an /alerts endpoint.
 */
export function useNotificationsFeed(): void {
  const setItems = useNotificationsStore((s) => s.setItems);

  const items: Notification[] = useMemo(() => {
    const out: Notification[] = [];
    mockData.items
      .filter((i) => i.status === 'Low stock')
      .slice(0, 5)
      .forEach((i) =>
        out.push({
          id: `low-${i.id}`,
          kind: 'low',
          icon: 'warn',
          tone: 'warning',
          title: 'Low stock',
          body: `${i.desc} (${i.id}) is at ${i.qty} units — below the reorder threshold of ${i.threshold}.`,
          itemId: i.id,
          ts: 'Just now',
        }),
      );
    mockData.items
      .filter((i) => i.status === 'Expiring')
      .slice(0, 5)
      .forEach((i) =>
        out.push({
          id: `exp-${i.id}`,
          kind: 'expire',
          icon: 'info',
          tone: 'warning',
          title: 'Expiring soon',
          body: `${i.desc} (Lot ${i.lot}) expires ${i.expires}.`,
          itemId: i.id,
          ts: '2 hours ago',
        }),
      );
    out.push({
      id: 'audit-export-weekly',
      kind: 'audit',
      icon: 'info',
      tone: 'accent',
      title: 'Audit export ready',
      body: 'Weekly audit export for May 13–20 is available to download.',
      ts: 'Today, 09:00',
    });
    return out;
  }, []);

  useEffect(() => {
    setItems(items);
  }, [items, setItems]);
}
