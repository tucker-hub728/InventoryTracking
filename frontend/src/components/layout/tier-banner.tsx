'use client';

import { useDeploymentTier } from '@/components/providers/deployment-tier-provider';
import { tierMarking } from '@/config/deployment-tier';

/**
 * A strip naming the environment across the top of the sign-in pages, which
 * have no header to colour — and signing in is exactly where someone picks the
 * wrong environment. Renders nothing in Production.
 *
 * Fixed rather than in flow so the auth shell keeps its full-height centring;
 * the shell's own top padding already clears it.
 */
export function TierBanner() {
  const tier = tierMarking(useDeploymentTier());
  if (!tier) return null;
  return (
    <div
      role="note"
      className="tier-banner fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 px-4 py-1.5 text-center text-xs font-medium"
    >
      <span className="tier-pill">{tier.label}</span>
      <span className="truncate">{tier.message}</span>
    </div>
  );
}
