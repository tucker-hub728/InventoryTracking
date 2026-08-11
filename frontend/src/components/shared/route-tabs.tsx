'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

export interface RouteTab {
  href: string;
  label: string;
  /** Optional count rendered as a muted pill after the label. */
  count?: number;
}

interface Props {
  tabs: readonly RouteTab[];
  /** Describes the tab group for screen readers, e.g. "User directory". */
  label: string;
  className?: string;
}

/**
 * Tabs that are real routes.
 *
 * Radix ``Tabs`` keeps the selected panel in component state, so the tab a user
 * is on has no address: refreshing drops them back on the first one and there
 * is no link to send somebody. These render as ``<Link>``s instead, one URL per
 * tab, which also lets each tab own its own query string (page, search) without
 * the tabs fighting over one.
 *
 * Styling deliberately mirrors ``components/ui/tabs`` so a page converted from
 * Radix tabs to routed ones looks unchanged. ``scroll-strip`` keeps the last
 * tab reachable on a narrow screen rather than clipped (REQ-2026-07-15-UI-002).
 */
export function RouteTabs({ tabs, label, className }: Props) {
  const pathname = usePathname();

  return (
    <div className={cn('scroll-strip pb-px', className)}>
      <nav
        aria-label={label}
        className="inline-flex items-center justify-start gap-1 border-b border-border [&>*]:shrink-0"
      >
        {tabs.map((tab) => {
          // Exact match, not ``startsWith``: these tab sets are siblings under
          // one parent, so a prefix test would light up two tabs whenever one
          // href is a prefix of another.
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                '-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3.5 py-2.5 text-sm font-normal text-text-2 outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-accent',
                active && 'border-text font-medium text-text',
              )}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className="rounded-sm bg-surface px-1.5 py-0.5 text-[11px] tabular-nums text-text-3">
                  {tab.count.toLocaleString()}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
