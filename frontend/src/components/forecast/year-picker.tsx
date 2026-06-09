'use client';

import * as React from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface YearPickerProps {
  value: number;
  onChange: (year: number) => void;
  /** Inclusive bounds — defaults match the backend CHECK (2000–2100). */
  min?: number;
  max?: number;
  className?: string;
  ariaLabel?: string;
}

const decadeStart = (year: number) => Math.floor(year / 10) * 10;

/**
 * Year picker — a calendar-style popover showing a decade grid (with the
 * trailing/leading neighbour years dimmed), navigable decade-by-decade. Click a
 * year to select it. Bounded to [min, max] (the DB-allowed range), so it reaches
 * any valid year without a fixed dropdown list.
 */
export function YearPicker({
  value,
  onChange,
  min = 2000,
  max = 2100,
  className,
  ariaLabel = 'Year',
}: YearPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState(() => decadeStart(value));

  // Re-anchor the viewed decade on the selected year each time we open.
  React.useEffect(() => {
    if (open) setView(decadeStart(value));
  }, [open, value]);

  // 12 cells: trailing prev-decade year, the ten decade years, leading next.
  const cells = Array.from({ length: 12 }, (_, i) => view - 1 + i);

  const select = (year: number) => {
    onChange(Math.max(min, Math.min(max, year)));
    setOpen(false);
  };

  const navBtn =
    'flex size-7 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-surface hover:text-text disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            'inline-flex h-8 min-w-[110px] items-center justify-between gap-2 rounded-md border border-border-strong bg-bg-elev px-2.5 text-sm text-text shadow-sm transition-colors hover:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/30',
            className,
          )}
        >
          <span className="tabular-nums">{value}</span>
          <CalendarDays className="size-3.5 text-text-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <div className="mb-1 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setView((v) => v - 10)}
            disabled={view - 1 < min}
            aria-label="Previous decade"
            className={navBtn}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <span className="text-sm font-medium tabular-nums">
            {view}–{view + 9}
          </span>
          <button
            type="button"
            onClick={() => setView((v) => v + 10)}
            disabled={view + 10 > max}
            aria-label="Next decade"
            className={navBtn}
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {cells.map((year) => {
            const outOfDecade = year < view || year > view + 9;
            const disabled = year < min || year > max;
            const selected = year === value;
            return (
              <button
                key={year}
                type="button"
                disabled={disabled}
                onClick={() => select(year)}
                aria-current={selected ? 'date' : undefined}
                className={cn(
                  'flex h-9 items-center justify-center rounded-md text-sm tabular-nums transition-colors',
                  'hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                  outOfDecade && 'text-text-3',
                  disabled && 'pointer-events-none opacity-30',
                  selected && 'bg-accent font-medium text-white hover:bg-accent',
                )}
              >
                {year}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
