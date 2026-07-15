'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Shield,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuthStore } from '@/stores/auth.store';
import { useUIStore } from '@/stores/ui.store';
import { env } from '@/env';

export function Topbar() {
  const router = useRouter();
  const sidebarCollapsed = useUIStore((s) => s.sidebar === 'icon');
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const user = useAuthStore((s) => s.user);
  const clearSession = useAuthStore((s) => s.clear);

  const handleSignOut = React.useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // Even if the network call fails, clear local state so the UI matches.
    }
    clearSession();
    router.replace('/login');
    router.refresh();
  }, [clearSession, router]);

  return (
    <header className="sticky top-0 z-40 flex h-[52px] items-center justify-between gap-4 border-b border-border bg-bg-elev px-6 sm:px-8">
      <div className="flex min-w-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="default"
              onClick={toggleSidebar}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-pressed={sidebarCollapsed}
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen size={15} />
              ) : (
                <PanelLeftClose size={15} />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          </TooltipContent>
        </Tooltip>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-3">
          <Shield size={13} aria-hidden />
          <span className="truncate">{env.ENV_LABEL}</span>
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        {/*
          Theme toggle and notifications bell — temporarily hidden. Restore
          both (plus the `Bell`/`Moon`/`Sun` icon imports, the `theme` /
          `toggleTheme` / notifications-store selectors and the
          `useNotificationsFeed()` call) from git history when they're wanted
          again. The notifications feed is still mock-data-backed, so the bell
          shows a fabricated unread count until it's wired to a real source.

          Role switcher (demo) — also hidden. The "Viewing as <role>" dropdown
          let you switch between mock roles; restore it from git history when
          the demo is needed again. Sign out is kept below so users can still
          log out.
        */}
        {user && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="default"
                onClick={() => void handleSignOut()}
                aria-label="Sign out"
              >
                <LogOut size={15} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Sign out</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
