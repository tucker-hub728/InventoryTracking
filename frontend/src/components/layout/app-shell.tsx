'use client';

import * as React from 'react';

import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { ErrorBoundary } from '@/components/shared/error-boundary';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <div className="flex-1 bg-bg">
          <ErrorBoundary>{children}</ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
