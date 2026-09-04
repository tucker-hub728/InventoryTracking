'use client';

import { useAuthStore } from '@/stores/auth.store';
import { useNotificationsStream } from '@/hooks/use-notifications-stream';
import { can } from '@/lib/permissions';

/**
 * Owns the one live connection this application holds open (NOTIF-001).
 *
 * Mounted in `app/(app)/layout.tsx` inside `<AuthGuard>`, and the placement is
 * load-bearing:
 *
 * * `AuthGuard` renders `null` until `hydrated && user`, so the stream can
 *   never open before we know who is connecting.
 * * The `(auth)` route group — `/login`, `/forgot-password`, `/set-password` —
 *   is a sibling with its own layout, so this cannot mount there.
 * * A Next layout persists across every in-group navigation, so the connection
 *   is opened once per session rather than once per page.
 *
 * Not in `AppProviders`, which also wraps the login page. Not in `Topbar`,
 * where the old feed hook lived — tying a connection's lifetime to a header
 * component makes it a header component's problem. And emphatically not in
 * `Sidebar`, which renders twice (desktop rail plus mobile drawer) and would
 * therefore hold two streams per user.
 *
 * Gated on `inventory:view`, matching how `sidebar.tsx` gates `useNavCounts`.
 * The old feed hook was ungated, so a read-only user fired both underlying
 * queries on every navigation for a panel that was not theirs to act on.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  useNotificationsStream(can(user, 'inventory', 'view'));
  return <>{children}</>;
}
