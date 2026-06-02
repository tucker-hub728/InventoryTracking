'use client';

import * as React from 'react';
import { AlertTriangle, Check, Info } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useNotificationsStore } from '@/stores/notifications.store';
import { cn } from '@/lib/utils';
import type { Notification, NotificationKind } from '@/types/notification';
import type { BadgeTone } from '@/types/ui';

const ICON_MAP: Record<Notification['icon'], LucideIcon> = {
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

export function NotificationsPanel({ total }: { total: number }) {
  const items = useNotificationsStore((s) => s.items);
  const read = useNotificationsStore((s) => s.read);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const markRead = useNotificationsStore((s) => s.markRead);
  const email = useNotificationsStore((s) => s.emailDelivery);
  const sms = useNotificationsStore((s) => s.smsDelivery);
  const toggleEmail = useNotificationsStore((s) => s.toggleEmail);
  const toggleSms = useNotificationsStore((s) => s.toggleSms);

  return (
    <div className="flex max-h-[520px] flex-col overflow-hidden rounded-md">
      <div className="flex items-center justify-between border-b border-border px-3.5 py-3">
        <div className="text-sm font-semibold">Notifications</div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggleEmail}
            aria-pressed={email}
            className={cn(
              'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors',
              email
                ? 'bg-success-soft text-success'
                : 'bg-surface-2 text-text-3 hover:bg-surface',
            )}
          >
            {email && <Check size={10} />} Email
          </button>
          <button
            type="button"
            onClick={toggleSms}
            aria-pressed={sms}
            className={cn(
              'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors',
              sms
                ? 'bg-success-soft text-success'
                : 'bg-surface-2 text-text-3 hover:bg-surface',
            )}
          >
            {sms && <Check size={10} />} SMS
          </button>
        </div>
      </div>
      <ul className="max-h-[380px] overflow-y-auto">
        {items.length === 0 && (
          <li className="px-3.5 py-8 text-center text-xs text-text-3">No notifications</li>
        )}
        {items.map((n) => {
          const Icon = ICON_MAP[n.icon];
          const tone = TONE_CLASS[n.tone];
          const isRead = read.has(n.id);
          return (
            <li
              key={n.id}
              className={cn(
                'flex cursor-pointer gap-2.5 border-t border-border px-3.5 py-3 transition-colors first:border-t-0 hover:bg-surface',
                isRead && 'opacity-70',
              )}
              onClick={() => markRead(n.id)}
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
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between border-t border-border bg-surface px-3.5 py-2 text-xs">
        <button
          type="button"
          onClick={markAllRead}
          className="text-text-2 transition-colors hover:text-text"
        >
          Mark all as read
        </button>
        <span className="text-text-3">{total} total</span>
      </div>
    </div>
  );
}

export type { NotificationKind };
