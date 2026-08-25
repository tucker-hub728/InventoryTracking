import { api } from './client';
import type { Notification } from '@/types/notification';

export interface NotificationList {
  items: Notification[];
  total: number;
  limit: number;
  offset: number;
  /**
   * Counted over the whole feed, not this page. The feed this replaced fetched
   * ten rows and showed that count as the total, so the badge said "10" whether
   * there were ten or two hundred.
   */
  unread_count: number;
}

export interface MarkReadResult {
  updated: number;
  unread_count: number;
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * The bell's REST surface.
 *
 * The live stream is deliberately not here: `EventSource` is not `fetch`, so it
 * does not go through `client.ts`. It lives in `use-notifications-stream.ts`
 * and talks to `/api/v1/notifications/stream`, which is its own streaming BFF
 * route — the catch-all proxy buffers and cannot carry it.
 */
/** Which tab of the panel to page. Mirrors the backend's `status` query param. */
export type NotificationStatus = 'unread' | 'read' | 'all';

export const notificationsApi = {
  list: (
    params: { status?: NotificationStatus; limit?: number; offset?: number } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<NotificationList>(
      `/notifications${qs({
        status: params.status,
        limit: params.limit === undefined ? undefined : String(params.limit),
        offset: params.offset === undefined ? undefined : String(params.offset),
      })}`,
      { signal: opts?.signal },
    ),

  /** Durable, per-user, and idempotent — a second click does not move `read_at`. */
  markRead: (id: string) => api.post<MarkReadResult>(`/notifications/${id}/read`),

  markAllRead: () => api.post<MarkReadResult>('/notifications/read-all'),

  /** Hides the row from every view, for this user only. */
  dismiss: (id: string) => api.post<MarkReadResult>(`/notifications/${id}/dismiss`),
};
