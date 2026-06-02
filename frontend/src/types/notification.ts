import type { BadgeTone } from './ui';

export type NotificationKind = 'low' | 'expire' | 'info' | 'audit';

export interface Notification {
  id: string;
  kind: NotificationKind;
  icon: 'warn' | 'info' | 'check';
  tone: BadgeTone;
  title: string;
  body: string;
  itemId?: string;
  ts: string;
  read?: boolean;
}
