'use client';

import { useEffect } from 'react';

import { notificationsApi } from '@/lib/api/notifications';
import { useNotificationsStore } from '@/stores/notifications.store';
import type { NotificationFeed } from '@/types/notification';

const STREAM_URL = '/api/v1/notifications/stream';

/** Reconnect backoff. The server closes cleanly every ~10 minutes so the token
 *  can be refreshed, and a rolling deploy drops every stream at least once, so
 *  reconnecting is the normal case rather than the failure case — the first
 *  retry is deliberately quick. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * Keeps the notifications store fed from the live SSE stream.
 *
 * Each event carries a **snapshot** of the caller's unread head plus the true
 * unread count, not a delta. That is what makes this safe: a missed event, a
 * reconnect, or a deploy that drops the connection all self-correct on the next
 * frame, and there is no cursor to get wrong. (A `created_at` cursor would be
 * quietly wrong anyway — commit order is not timestamp order.)
 *
 * `EventSource` reconnects on its own after a network drop, but gives up
 * permanently on a non-2xx response. Since a 401 is expected — the access token
 * is only good for an hour — reconnection is driven here rather than left to
 * the browser: a fresh `EventSource` re-enters the BFF route, which refreshes
 * the token and replays. The browser's own retry would never do that.
 */
export function useNotificationsStream(enabled: boolean): void {
  const setFeed = useNotificationsStore((s) => s.setFeed);
  const setConnected = useNotificationsStore((s) => s.setConnected);
  const reset = useNotificationsStore((s) => s.reset);

  useEffect(() => {
    if (!enabled) {
      reset();
      return;
    }

    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = RETRY_MIN_MS;
    let stopped = false;

    // Paint from REST first. The stream sends a snapshot the moment it opens,
    // so this is redundant on the happy path — but if SSE is blocked by
    // something between here and the backend, the bell is still correct and
    // simply stops being live. A silently empty bell reads as good news.
    const ctrl = new AbortController();
    notificationsApi
      .list({ status: 'unread', limit: 20 }, { signal: ctrl.signal })
      .then((res) => {
        if (!stopped) setFeed(res.items, res.unread_count);
      })
      .catch(() => {
        // Leave the store as-is; the stream is the primary path.
      });

    const connect = () => {
      if (stopped) return;
      source = new EventSource(STREAM_URL);

      source.addEventListener('open', () => {
        retryMs = RETRY_MIN_MS;
        setConnected(true);
      });

      source.addEventListener('snapshot', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as NotificationFeed;
          setFeed(data.items ?? [], data.unread_count ?? 0);
        } catch {
          // A frame we can't parse is not worth tearing the connection down
          // for — the next snapshot supersedes it entirely.
        }
      });

      source.addEventListener('error', () => {
        setConnected(false);
        source?.close();
        source = null;
        if (stopped) return;
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      });
    };

    connect();

    return () => {
      stopped = true;
      ctrl.abort();
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
      setConnected(false);
    };
  }, [enabled, setFeed, setConnected, reset]);
}
