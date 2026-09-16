'use client';

import * as React from 'react';

import type { DeploymentTier } from '@/config/deployment-tier';

// Defaults to `unknown`, not `production`: a component rendered outside the
// provider should look misconfigured, never quietly look like Production.
const DeploymentTierContext = React.createContext<DeploymentTier>('unknown');

/**
 * Hands the tier resolved on the server (see `app/layout.tsx`) to client
 * components. It is a prop from the server rather than something the client
 * reads itself because `process.env` in the browser only holds what was inlined
 * at build time — and the same build runs in every environment.
 */
export function DeploymentTierProvider({
  tier,
  children,
}: {
  tier: DeploymentTier;
  children: React.ReactNode;
}) {
  return <DeploymentTierContext.Provider value={tier}>{children}</DeploymentTierContext.Provider>;
}

export function useDeploymentTier(): DeploymentTier {
  return React.useContext(DeploymentTierContext);
}
