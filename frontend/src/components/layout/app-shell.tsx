'use client';

import * as React from 'react';

import { Sidebar, SidebarDrawer } from './sidebar';
import { Topbar } from './topbar';
import { ErrorBoundary } from '@/components/shared/error-boundary';

export function AppShell({ children }: { children: React.ReactNode }) {
  // Whether the narrow-screen nav drawer is showing. Deliberately NOT in the
  // persisted UI store: it is a transient position, not a preference, and
  // restoring it on load would open the drawer over the page you asked for.
  const [navOpen, setNavOpen] = React.useState(false);

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar />
      <SidebarDrawer open={navOpen} onOpenChange={setNavOpen} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenNav={() => setNavOpen(true)} />
        {/* Deliberately NO ``overflow-x`` backstop here. It looks like the
            obvious guard against a wide child scrolling the whole page, but
            ``overflow-x: auto`` forces ``overflow-y`` to a scrolling value too:
            this div becomes the scroll container, the page stops scrolling, and
            every ``position: sticky`` header, the sticky room search and
            BackToTop (which reads ``window.scrollY``) all break at once.
            ``overflow-x: clip`` avoids that but silently cuts the content off
            instead. Wide children are fixed where they are, individually. */}
        <div className="min-w-0 flex-1 bg-bg">
          <ErrorBoundary>{children}</ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
