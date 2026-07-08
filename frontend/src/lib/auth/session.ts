/**
 * Session helpers for the BFF.
 *
 * - ``toSessionUser`` projects a backend ``/me`` payload into the public
 *   shape we ship to the client.
 * - ``readSession`` reads cookies + calls ``/me``, handling silent refresh
 *   when the access token has expired but a refresh is still on file.
 */

// Server-only by convention — uses next/headers which is server-only at
// runtime anyway, but keep usage to route handlers / server components.
import { cookies } from 'next/headers';
import { type NextResponse } from 'next/server';

import { AUTH_COOKIES, setAuthCookies } from './cookies';
import { backend, BackendError } from './backend';
import { mapBackendRoleToRoleId } from './role-map';
import type { BackendMe, BackendTokens, SessionUser } from './types';

export function toSessionUser(me: BackendMe): SessionUser {
  return {
    sub: me.sub,
    email: me.email ?? me.username,
    fullName: me.full_name ?? me.username,
    initials: (me.initials ?? me.username.slice(0, 2)).toUpperCase(),
    rawRole: me.role ?? 'viewer',
    roleId: mapBackendRoleToRoleId(me.role),
  };
}

export interface ReadSessionResult {
  user: SessionUser | null;
  /** Set when a silent refresh ran — caller must persist these on the response. */
  refreshedTokens?: BackendTokens;
}

/**
 * Resolve the current session from request cookies. Falls back to a silent
 * refresh if the access token is missing or expired but a refresh token is
 * still on file. Returns ``{ user: null }`` if no session can be re-established.
 *
 * The caller is responsible for piping ``refreshedTokens`` (if present) into
 * the outgoing response via ``setAuthCookies``.
 */
export async function readSession(): Promise<ReadSessionResult> {
  const jar = cookies();
  const at = jar.get(AUTH_COOKIES.access)?.value;
  const rt = jar.get(AUTH_COOKIES.refresh)?.value;

  if (at) {
    try {
      const me = await backend.me(at);
      // A since-deactivated account still has valid tokens but must be treated
      // as logged out so the app-shell bounces them to /login.
      if (me.is_active === false) return { user: null };
      return { user: toSessionUser(me) };
    } catch (err) {
      if (!(err instanceof BackendError) || err.status !== 401) throw err;
      // fall through to refresh path
    }
  }

  if (!rt) return { user: null };

  let fresh: BackendTokens;
  try {
    fresh = await backend.refresh(rt);
  } catch (err) {
    if (err instanceof BackendError && err.status === 401) return { user: null };
    throw err;
  }
  const me = await backend.me(fresh.access_token);
  if (me.is_active === false) return { user: null };
  return { user: toSessionUser(me), refreshedTokens: fresh };
}

/** Convenience: persist a silently-refreshed token pair on the outgoing response. */
export function applyRefreshedCookies(
  res: NextResponse,
  tokens: BackendTokens | undefined,
): void {
  if (!tokens) return;
  setAuthCookies(res, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token, // null on refresh; setAuthCookies skips it
    accessMaxAgeSeconds: tokens.expires_in,
  });
}
