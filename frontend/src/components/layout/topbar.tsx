'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Bell,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Shield,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { NotificationsPanel } from './notifications-panel';
import { useNotificationsFeed } from '@/hooks/use-notifications-feed';
import { useAuthStore } from '@/stores/auth.store';
import { useNotificationsStore, selectUnreadCount } from '@/stores/notifications.store';
import { useUIStore } from '@/stores/ui.store';
import { env } from '@/env';

export function Topbar({ onOpenNav }: { onOpenNav?: () => void }) {
  const router = useRouter();
  const sidebarCollapsed = useUIStore((s) => s.sidebar === 'icon');
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const user = useAuthStore((s) => s.user);
  const clearSession = useAuthStore((s) => s.clear);

  // Restored 2026-08-24 with PLN-001: the bell was hidden because the feed was
  // mock-data-backed and showed a fabricated unread count. It now reads
  // /planning/reorder and /consumables/expiring, so the count is real.
  useNotificationsFeed();
  const unread = useNotificationsStore(selectUnreadCount);
  const notificationCount = useNotificationsStore((s) => s.items.length);

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
    <header className="sticky top-0 z-40 flex h-[52px] items-center justify-between gap-4 border-b border-border bg-bg-elev px-4 sm:px-6 lg:px-8">
      <div className="flex min-w-0 items-center gap-2">
        {/* Below lg the nav has no column of its own, so this is the only way
            to reach it. Above lg the nav is always on screen and this button
            would do nothing. */}
        <Button
          size="icon"
          variant="default"
          onClick={onOpenNav}
          aria-label="Open navigation"
          className="lg:hidden"
        >
          <Menu size={16} />
        </Button>
        {/* The collapse preference only has an effect from 1280 up — below that
            the width is decided for us, so the control is hidden rather than
            left to look broken. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="default"
              onClick={toggleSidebar}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-pressed={sidebarCollapsed}
              className="hidden xl:inline-flex"
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
          Theme toggle — still hidden. Restore it (plus the `Moon`/`Sun` icon
          imports and the `theme` / `toggleTheme` selectors) from git history
          when it's wanted again.

          Role switcher (demo) — also hidden. The "Viewing as <role>" dropdown
          let you switch between mock roles; restore it from git history when
          the demo is needed again. Sign out is kept below so users can still
          log out.
        */}

        {/* Notifications (PLN-001 + LOC-008) */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="icon"
              variant="default"
              className="relative"
              aria-label={`${unread} unread notifications`}
            >
              <Bell size={15} />
              {unread > 0 && (
                <span
                  aria-hidden
                  className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full border-2 border-bg-elev bg-accent px-1 text-[10px] font-semibold leading-none text-white"
                >
                  {unread}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[380px]">
            <NotificationsPanel total={notificationCount} />
          </PopoverContent>
        </Popover>

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
