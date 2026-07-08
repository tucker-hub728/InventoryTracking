'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Bell,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { NotificationsPanel } from './notifications-panel';
import { useAuthStore } from '@/stores/auth.store';
import { useUIStore } from '@/stores/ui.store';
import { useNotificationsStore, selectUnreadCount } from '@/stores/notifications.store';
import { useNotificationsFeed } from '@/hooks/use-notifications-feed';

// Theme toggle, notifications, and sign-out are hidden from the topbar for now
// (sign-out remains available from the sidebar user menu). Flip to restore.
const SHOW_TOPBAR_ACTIONS = false;

export function Topbar() {
  useNotificationsFeed();
  const router = useRouter();
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const sidebarCollapsed = useUIStore((s) => s.sidebar === 'icon');
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const user = useAuthStore((s) => s.user);
  const clearSession = useAuthStore((s) => s.clear);
  const unread = useNotificationsStore(selectUnreadCount);
  const total = useNotificationsStore((s) => s.items.length);

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
      </div>

      {SHOW_TOPBAR_ACTIONS && (
      <div className="flex items-center gap-1.5">
        {/* Theme toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="default"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          </TooltipContent>
        </Tooltip>

        {/* Notifications */}
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
            <NotificationsPanel total={total} />
          </PopoverContent>
        </Popover>

        {/*
          Role switcher (demo) — temporarily hidden. The "Viewing as <role>"
          dropdown let you switch between mock roles; restore it from git
          history when the demo is needed again. Sign out is kept below so
          users can still log out.
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
      )}
    </header>
  );
}
