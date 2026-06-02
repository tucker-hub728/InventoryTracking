'use client';

import * as React from 'react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { ThemeApplier } from './theme-applier';

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={150} skipDelayDuration={0}>
      <ThemeApplier />
      {children}
      <Toaster />
    </TooltipProvider>
  );
}
