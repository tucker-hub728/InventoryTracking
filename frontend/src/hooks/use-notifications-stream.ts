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
 * **The stream is paused while the tab is hidden**, and that is not an
 * optimisation — it is a correctness fix. HTTP/1.1 allows a browser only ~6
 * concurrent connections per origin, and an SSE stream holds one open for its
 * whole life. Six tabs of this app therefore consumed the entire budget between
 * them, and every other request to the origin — page loads, API calls, HMR —
 * queued behind them forever. The symptom is a tab stuck on a blank "Loading…"
 * with no error anywhere, because nothing failed; it was never sent.
 *
 * A hidden tab has no bell to update, so it gives its connection back and takes
 * one again when the user returns. The snapshot-per-event design (above) is what
 * makes that free: reopening re-reads the whole unread head, so a stream that
 * was closed for an hour is not behind, it is simply new.
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

    // Hand the connection back while nobody is looking at this tab, and take
    // one again on return. `visibilitychange` also fires when the whole window
    // is minimised or the machine sleeps, which is exactly when we want it.
    const disconnect = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      source?.close();
      source = null;
      setConnected(false);
    };

    const onVisibility = () => {
      if (document.hidden) {
        disconnect();
      } else if (!source && !stopped) {
        // Straight back in, no backoff: this is a deliberate reopen, not a
        // recovery from a failure.
        retryMs = RETRY_MIN_MS;
        connect();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) connect();

    return () => {
      stopped = true;
      ctrl.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      disconnect();
    };
  }, [enabled, setFeed, setConnected, reset]);
}
