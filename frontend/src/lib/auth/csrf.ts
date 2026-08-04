/**
 * Same-origin enforcement for state-changing requests.
 *
 * Every mutating call in this app rides ambient HttpOnly cookies, and the
 * only thing standing between a hostile page and a state change was the
 * cookies' `SameSite=Lax` attribute. That is one control, and it is weaker
 * than it looks: `Lax` is scoped to the registrable domain (a sibling
 * subdomain counts as same-site), it still permits top-level cross-site
 * GETs, and it evaporates entirely if the cookies are ever switched to
 * `SameSite=None` for an embedding scenario. A regulated system that can
 * authorise e-signatures needs a second, independent barrier.
 *
 * `Sec-Fetch-Site` is the primary signal: browsers set it themselves and
 * page JavaScript cannot override it, so it is trustworthy in exactly the
 * threat model we care about. Origin is the fallback for the handful of
 * agents that omit Sec-Fetch-*.
 */

import { type NextRequest } from 'next/server';

/** Methods that must never change state, and so never need the check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True when this is a state-changing request that did NOT originate from
 * our own origin — i.e. it should be refused.
 */
export function isCrossSiteMutation(req: NextRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return false;

  const site = req.headers.get('sec-fetch-site');
  if (site) {
    // 'same-origin' — our own page. 'none' — user-initiated (address bar,
    // bookmark), which cannot be driven by an attacker's page.
    return site !== 'same-origin' && site !== 'none';
  }

  const origin = req.headers.get('origin');
  // No Origin header at all means a non-browser client (curl, the smoke
  // suites, server-to-server). Browsers always attach Origin to cross-site
  // mutations, so allowing this does not open the CSRF path back up.
  if (!origin) return false;

  return origin !== req.nextUrl.origin;
}

/** Body for the 403 returned when the check fails. */
export const CSRF_BLOCKED = {
  code: 'csrf_blocked',
  message: 'Cross-site request blocked.',
} as const;
