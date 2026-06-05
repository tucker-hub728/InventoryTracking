import * as React from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';

export interface Crumb {
  label: string;
  href?: string;
}

export interface PageHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  crumbs?: Crumb[];
  actions?: React.ReactNode;
  /** Optional tab bar rendered below the title row. */
  tabs?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  crumbs,
  actions,
  tabs,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        'border-b border-border bg-bg-elev px-6 pt-5 sm:px-8',
        className,
      )}
    >
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb">
          <ol className="mb-2.5 flex flex-wrap items-center gap-1.5 text-xs text-text-3">
            {crumbs.map((c, i) => (
              <React.Fragment key={`${c.label}-${i}`}>
                {i > 0 && <span aria-hidden>/</span>}
                {c.href ? (
                  <Link
                    href={c.href}
                    className="rounded-sm text-text-2 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span aria-current="page">{c.label}</span>
                )}
              </React.Fragment>
            ))}
          </ol>
        </nav>
      )}
      <div
        className={cn(
          'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
          tabs ? 'pb-3' : 'pb-5',
        )}
      >
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && (
            <div className="mt-1 text-sm text-text-2">{subtitle}</div>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {tabs}
    </header>
  );
}
