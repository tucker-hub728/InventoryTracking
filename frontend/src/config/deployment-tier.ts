/**
 * Which deployment this is — Production, the Sandbox, or a developer's machine —
 * and how each one marks itself on screen. The single source for the tier's
 * name, label and colour: CSS reads the colour from `--tier`, which the root
 * layout sets from this file, so nothing else picks a tier colour.
 *
 * Requested by the client (2026-09-17): the Sandbox is used for training and
 * looked identical to Production, so it was easy to work in the wrong one.
 *
 * WHY THIS IS A RUNTIME VALUE, NOT A `NEXT_PUBLIC_*` ONE: the deploy pipeline
 * builds each image once and promotes the same image from the Sandbox to
 * Production. `NEXT_PUBLIC_*` values are inlined at build time, so a label set
 * that way would read identically in both environments — which is exactly the
 * confusion this exists to prevent. `DEPLOYMENT_TIER` is read on the server per
 * request instead. `APP_ENV` is deliberately not reused: it is `production` in
 * BOTH deployed environments and drives security invariants.
 */

export type DeploymentTier = 'production' | 'sandbox' | 'local' | 'unknown';

/**
 * Fail closed. An unset or misspelled value becomes `unknown`, which marks the
 * screen loudly — a missing setting must never make the Sandbox look like
 * Production.
 */
export function resolveDeploymentTier(raw: string | undefined): DeploymentTier {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'production':
      return 'production';
    case 'sandbox':
      return 'sandbox';
    case 'local':
      return 'local';
    default:
      return 'unknown';
  }
}

interface TierMarking {
  /** Short label for the header pill and the browser tab prefix. */
  label: string;
  /** One line, in words — colour alone is not enough (WCAG 1.4.1). */
  message: string;
  /**
   * Header colour. Kept off the stock-status ladder (green / amber / red mean
   * In stock / Low stock / Out of stock) so the header never reads as a status —
   * except `unknown`, which is a genuine fault and should look like one.
   */
  color: string;
  /** Text on `color`. All four colours are dark, so white holds contrast. */
  onColor: string;
}

/** Production is absent on purpose: it shows nothing extra. The absence is the signal. */
export const TIER_MARKING: Record<Exclude<DeploymentTier, 'production'>, TierMarking> = {
  sandbox: {
    label: 'SANDBOX',
    message: 'Training environment — nothing you do here affects Production.',
    color: '#334155',
    onColor: '#ffffff',
  },
  local: {
    label: 'LOCAL',
    message: 'Local development environment.',
    color: '#1d4ed8',
    onColor: '#ffffff',
  },
  unknown: {
    label: 'ENVIRONMENT NOT SET',
    message: 'DEPLOYMENT_TIER is missing or invalid — this environment cannot identify itself.',
    color: '#b91c1c',
    onColor: '#ffffff',
  },
};

export function tierMarking(tier: DeploymentTier): TierMarking | null {
  return tier === 'production' ? null : TIER_MARKING[tier];
}

/**
 * Browser-tab icon for a marked tier: a square in the tier colour with its
 * initial, so the tab strip shows which environment a tab belongs to before
 * the page does. A data URI, which the CSP's `img-src data:` already allows.
 */
export function tierFavicon(tier: DeploymentTier): string | null {
  const marking = tierMarking(tier);
  if (!marking) return null;
  const glyph = tier === 'unknown' ? '!' : marking.label[0];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="${marking.color}"/>` +
    `<text x="16" y="22.5" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" ` +
    `font-size="19" font-weight="700" fill="${marking.onColor}">${glyph}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
