'use client';

import * as React from 'react';
import { CornerDownRight, MapPin } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * A location shown as its NAME, with the full hierarchy one hover away.
 *
 * A stored path reads "Materials Management / Warehouse One / Shelf A". In a
 * table column that is three problems at once: it truncates to
 * "Materials Manage…" so the one part that identifies the place — the last —
 * is the part you lose; every row repeats the same two ancestors, which carry
 * no information when they are identical down the column; and it is five times
 * wider than the fact it conveys.
 *
 * So the cell shows the leaf, and the ancestry is available on demand. The
 * tooltip draws it as a descent rather than re-printing the slash-separated
 * string, because the relationship between the parts IS the content — and the
 * leaf is marked so the eye lands on the same word it just hovered.
 *
 * A tooltip, not a click-popover: this is a reference detail, and requiring a
 * click to read where something came from turns a glance into a task. Radix
 * opens it on focus too, so it is reachable without a mouse.
 */
export function LocationPath({
  path,
  className,
  /** Separator used by the stored path. Node paths use "/", some use "›". */
  separator,
}: {
  path: string | null | undefined;
  className?: string;
  separator?: string;
}) {
  const parts = React.useMemo(() => {
    if (!path) return [];
    const sep = separator ?? (path.includes('›') ? '›' : '/');
    return path
      .split(sep)
      .map((p) => p.trim())
      .filter(Boolean);
  }, [path, separator]);

  if (parts.length === 0) {
    return <span className="text-text-3">—</span>;
  }

  const leaf = parts[parts.length - 1]!;

  // Nothing to reveal — showing a hover affordance that opens a one-line
  // tooltip repeating the visible text is a promise the UI does not keep.
  if (parts.length === 1) {
    return <span className={cn('truncate', className)}>{leaf}</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex max-w-full items-center gap-1 truncate text-left underline decoration-dotted decoration-text-3 underline-offset-4 hover:decoration-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
            className,
          )}
        >
          <MapPin size={11} className="shrink-0 text-text-3" />
          <span className="truncate">{leaf}</span>
        </button>
      </TooltipTrigger>
      {/* Overrides the default tooltip skin, which is INVERTED (`bg-text` with
          `text-bg`) for one-line hints. This is a structured panel, not a hint:
          on that dark ground the leaf — styled as primary ink — rendered dark on
          dark and simply vanished, leaving an arrow pointing at nothing. A
          surface ground keeps the app's normal text hierarchy meaningful, which
          is what lets the leaf read as the emphasised row. */}
      <TooltipContent
        side="top"
        align="start"
        className="max-w-xs border-border bg-bg-elev p-0 text-text shadow-elev-sm"
      >
        <div className="px-3 py-2">
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-text-3">
            Location
          </p>
          <ol className="space-y-0.5">
            {parts.map((part, i) => {
              const isLeaf = i === parts.length - 1;
              return (
                <li
                  key={`${part}-${i}`}
                  className="flex items-center gap-1.5 whitespace-nowrap text-xs"
                  style={{ paddingLeft: i * 12 }}
                >
                  {i > 0 && (
                    <CornerDownRight size={11} className="shrink-0 text-text-3" aria-hidden />
                  )}
                  <span className={isLeaf ? 'font-medium text-text' : 'text-text-2'}>{part}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
