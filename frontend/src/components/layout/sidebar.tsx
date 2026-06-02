'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';

import { cn, getInitials } from '@/lib/utils';
import { navSections } from '@/config/nav';
import { siteConfig } from '@/config/site';
import { useAuthStore } from '@/stores/auth.store';
import { useUIStore } from '@/stores/ui.store';
import { can } from '@/lib/permissions';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const variant = useUIStore((s) => s.sidebar);
  const collapsed = variant === 'icon';
  const user = useAuthStore((s) => s.user);
  const clearSession = useAuthStore((s) => s.clear);

  const handleSignOut = React.useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // ignore; local state still cleared
    }
    clearSession();
    router.replace('/login');
    router.refresh();
  }, [clearSession, router]);

  return (
    <aside
      aria-label="Primary"
      className={cn(
        'sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-bg-elev transition-[width] duration-200',
        collapsed ? 'w-[60px]' : 'w-[220px]',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2.5 border-b border-border px-5 py-5',
          collapsed && 'justify-center px-0',
        )}
      >
        <div className="grid size-6 place-items-center rounded-sm bg-text font-mono text-[13px] font-semibold text-bg">
          {siteConfig.shortName.charAt(0)}
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight">{siteConfig.shortName}</div>
            <div className="text-[11px] text-text-3">{siteConfig.name.replace(' System', '')}</div>
          </div>
        )}
      </div>

      <nav
        className={cn(
          'flex-1 overflow-y-auto py-4',
          collapsed ? 'px-2' : 'px-3',
        )}
      >
        {navSections.map((section) => (
          <div key={section.title} className="mb-5">
            {collapsed ? (
              <div className="mx-1.5 mb-2 h-px bg-border" aria-hidden />
            ) : (
              <div className="px-2.5 pb-2 text-[10px] font-semibold uppercase tracking-widest text-text-3">
                {section.title}
              </div>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                if (item.resource && !can(user, item.resource as 'inventory', 'view')) {
                  return null;
                }
                const active =
                  !item.disabled &&
                  (pathname === item.href || pathname.startsWith(`${item.href}/`));
                // Render disabled rows as a button-shaped span — same
                // layout as the active link, but no navigation and the
                // hover tooltip explains why.
                const inner = (
                  <>
                    <item.icon size={collapsed ? 17 : 15} aria-hidden />
                    {!collapsed && (
                      <>
                        <span className="truncate">{item.label}</span>
                        {item.disabled ? (
                          <span
                            aria-label="In development"
                            className="ml-auto rounded-sm bg-surface-2 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-text-3"
                          >
                            WIP
                          </span>
                        ) : (
                          item.comingSoon && (
                            <span
                              aria-label="Coming soon"
                              className="ml-auto rounded-sm bg-surface-2 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-text-3"
                            >
                              Soon
                            </span>
                          )
                        )}
                      </>
                    )}
                  </>
                );
                const baseClass = cn(
                  'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm transition-colors',
                  collapsed && 'justify-center px-0',
                );
                const trigger = item.disabled ? (
                  <span
                    aria-disabled="true"
                    aria-current={undefined}
                    className={cn(
                      baseClass,
                      'cursor-not-allowed text-text-3 opacity-60',
                    )}
                  >
                    {inner}
                  </span>
                ) : (
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      baseClass,
                      active
                        ? 'bg-surface-2 font-medium text-text'
                        : 'text-text-2 hover:bg-surface hover:text-text',
                    )}
                  >
                    {inner}
                  </Link>
                );
                return (
                  <li key={item.id}>
                    {item.disabled ? (
                      <Tooltip>
                        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
                        <TooltipContent side="right" className="max-w-[260px]">
                          {item.disabledReason ??
                            'This module is still in development.'}
                        </TooltipContent>
                      </Tooltip>
                    ) : collapsed ? (
                      <Tooltip>
                        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
                        <TooltipContent side="right">{item.label}</TooltipContent>
                      </Tooltip>
                    ) : (
                      trigger
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {user && (
        <div className={cn('border-t border-border p-3', collapsed && 'p-2')}>
          <div
            className={cn(
              'flex items-center gap-2.5',
              collapsed ? 'justify-center' : 'p-1',
            )}
          >
            <Avatar className="size-7 text-[11px]">
              <AvatarFallback>{getInitials(user.name)}</AvatarFallback>
            </Avatar>
            {!collapsed && (
              <>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{user.name}</div>
                  <div className="truncate text-[11px] text-text-3">{user.roleName}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  aria-label="Sign out"
                  className="rounded-sm p-1.5 text-text-3 transition-colors hover:bg-surface hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <LogOut size={15} aria-hidden />
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
