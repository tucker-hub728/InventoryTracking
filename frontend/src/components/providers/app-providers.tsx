'use client';

import * as React from 'react';

import type { DeploymentTier } from '@/config/deployment-tier';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { DeploymentTierProvider } from './deployment-tier-provider';
import { ThemeApplier } from './theme-applier';

export function AppProviders({
  tier,
  children,
}: {
  tier: DeploymentTier;
  children: React.ReactNode;
}) {
  return (
    <DeploymentTierProvider tier={tier}>
      <TooltipProvider delayDuration={150} skipDelayDuration={0}>
        <ThemeApplier />
        {children}
        <Toaster />
      </TooltipProvider>
    </DeploymentTierProvider>
  );
}
