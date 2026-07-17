'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

export interface SegmentedOption {
  /** Stable value returned by ``onChange``. */
  value: string;
  label: React.ReactNode;
}

interface Props {
  options: readonly SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the group (e.g. "Filter raw materials"). */
  'aria-label': string;
  className?: string;
}

/**
 * A compact one-of-many control — the pill row used for list filters.
 *
 * A radiogroup rather than tabs: the choices filter a single list in place,
 * there is no panel per option, and exactly one is always active. Mirrors the
 * radiogroup pattern in ``tier-form-dialog``.
 */
export function SegmentedControl({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  className,
}: Props) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-border bg-bg-elev p-0.5',
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              active ? 'bg-surface text-text shadow-sm' : 'text-text-2 hover:text-text',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
