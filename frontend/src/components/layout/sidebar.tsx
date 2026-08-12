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
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BELOW_XL, useMediaQuery } from '@/hooks/use-media-query';
import { useNavCounts } from '@/hooks/use-nav-counts';

/**
 * The primary navigation, in whichever shape the viewport can afford
 * (REQ-2026-07-15-UI-001):
 *
 * * **≥1280** — a 220px column, or a 60px icon rail if that is the operator's
 *   saved preference.
 * * **1024–1279** (iPad landscape) — the icon rail, whatever the preference.
 *   160px of labels beside a table is the difference between the table fitting
 *   and not.
 * * **<1024** (iPad portrait, phone) — out of the layout entirely; it opens as
 *   an overlay drawer from the topbar's menu button. At 768px a fixed 220px
 *   column left 548px for the content it exists to navigate to; at 390px it
 *   left 170px, which is not a screen you can work on.
 *
 * The operator's own collapse preference is never overwritten by any of this —
 * it is read back the moment there is room for it again.
 */
export function Sidebar() {
  // Structural, not stylistic: a collapsed row renders a smaller glyph and
  // wraps its link in a tooltip, which CSS can't express.
  const forceRail = useMediaQuery(BELOW_XL);
  const variant = useUIStore((s) => s.sidebar);
  const collapsed = variant === 'icon' || forceRail;

  return (
    <aside
      aria-label="Primary"
      className={cn(
        // Hidden below lg — the drawer covers that range.
        'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-bg-elev transition-[width] duration-200 lg:flex',
        collapsed ? 'w-[60px]' : 'w-[220px]',
      )}
    >
      <SidebarContent collapsed={collapsed} />
    </aside>
  );
}

/**
 * The same navigation as an overlay drawer, for viewports too narrow to give it
 * a column (<1024px). Always labelled — the reason it is an overlay is that
 * there is no room beside the content, not that there is no room in it.
 */
export function SidebarDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const pathname = usePathname();

  // Navigating is the whole point of the drawer, so it closes behind you.
  React.useEffect(() => {
    onOpenChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-[260px] max-w-[85vw] p-0 lg:hidden"
        aria-label="Primary"
      >
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <div className="flex h-full flex-col">
          <SidebarContent collapsed={false} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SidebarContent({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const clearSession = useAuthStore((s) => s.clear);
  // Gated on the same permission the badged rows need: a read-only user who
  // cannot see inventory shouldn't be firing the count query at all.
  const navCounts = useNavCounts(can(user, 'inventory', 'view'));

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
    <>
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
                const badgeCount = item.badge ? (navCounts[item.badge] ?? 0) : 0;
                const inner = (
                  <>
                    {/* Collapsed to the icon rail there is no room for a
                        number, but "something needs you" still has to survive —
                        a dot on the glyph carries it. */}
                    {collapsed && badgeCount > 0 ? (
                      <span className="relative flex" aria-label={`${badgeCount} needing attention`}>
                        <item.icon size={17} aria-hidden />
                        <span
                          aria-hidden
                          className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-warning ring-2 ring-surface"
                        />
                      </span>
                    ) : (
                      <item.icon size={collapsed ? 17 : 15} aria-hidden />
                    )}
                    {!collapsed && (
                      <>
                        <span className="truncate">{item.label}</span>
                        {/* One right-hand slot for every pill. Each used to
                            carry its own `ml-auto`, which only works while
                            exactly one of them renders — the second would sit
                            flush against the first. */}
                        <span className="ml-auto flex shrink-0 items-center gap-1">
                          {(item.disabled || item.comingSoon) && (
                            <span
                              aria-label="In development"
                              className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-text-3"
                            >
                              WIP
                            </span>
                          )}
                          {/* Being replaced, not switched off — the row stays
                              clickable and everything inside still works. */}
                          {item.deprecated && (
                            <span
                              aria-label="Deprecated — being replaced"
                              className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-warning"
                            >
                              Deprecated
                            </span>
                          )}
                          {/* Count of things needing attention. Hidden at zero:
                              a "0" pill is visual noise that trains people to
                              ignore the badge that matters. */}
                          {badgeCount > 0 && (
                            <span
                              aria-label={`${badgeCount} needing attention`}
                              className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-warning"
                            >
                              {badgeCount > 99 ? '99+' : badgeCount}
                            </span>
                          )}
                        </span>
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
    </>
  );
}
