'use client';

import * as React from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { ApiLocation } from '@/lib/api/locations';

interface Props {
  locations: ApiLocation[];
  value: string;
  onChange: (value: string) => void;
  /**
   * Ids that may be picked. When omitted, only shelves (a location with a
   * parent) are selectable. Top-level locations are shown as non-clickable
   * group headers unless they are themselves selectable leaves.
   */
  selectableIds?: Set<string>;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}

interface Entry {
  /** Present ⇒ a selectable option; absent ⇒ a non-clickable header. */
  id?: string;
  label: string;
  depth: number;
  searchText: string;
  ancestors: number[];
}

export function LocationTreeSelect({
  locations,
  value,
  onChange,
  selectableIds,
  placeholder = 'Select location…',
  disabled,
  id,
  'aria-label': ariaLabel,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const isSelectable = React.useCallback(
    (loc: ApiLocation) =>
      selectableIds ? selectableIds.has(loc.id) : loc.parent_location_id !== null,
    [selectableIds],
  );

  const entries = React.useMemo<Entry[]>(() => {
    const tops = locations.filter((l) => l.parent_location_id === null);
    const childrenOf = (pid: string) => locations.filter((l) => l.parent_location_id === pid);

    // Ordered unique categories among top-level locations.
    const categories = [...new Set(tops.map((t) => t.location_type))];

    const out: Entry[] = [];
    for (const cat of categories) {
      const catTops = tops.filter((t) => t.location_type === cat);
      const visTops = catTops
        .map((t) => ({ t, shelves: childrenOf(t.id).filter(isSelectable) }))
        .filter(({ t, shelves }) => shelves.length > 0 || isSelectable(t));
      if (visTops.length === 0) continue;

      const catIdx = out.length;
      out.push({ label: cat, depth: 0, searchText: cat, ancestors: [] });

      for (const { t, shelves } of visTops) {
        if (shelves.length === 0 && isSelectable(t)) {
          // Childless top-level that itself holds stock — a selectable leaf.
          out.push({
            id: t.id,
            label: t.location_name,
            depth: 1,
            searchText: `${cat} ${t.location_name}`,
            ancestors: [catIdx],
          });
          continue;
        }
        const locIdx = out.length;
        out.push({ label: t.location_name, depth: 1, searchText: `${cat} ${t.location_name}`, ancestors: [catIdx] });
        for (const sh of shelves) {
          out.push({
            id: sh.id,
            label: sh.location_name,
            depth: 2,
            searchText: `${cat} ${t.location_name} ${sh.location_name}`,
            ancestors: [catIdx, locIdx],
          });
        }
      }
    }
    return out;
  }, [locations, isSelectable]);

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    const keep = new Set<number>();
    entries.forEach((e, i) => {
      if (e.id && e.searchText.toLowerCase().includes(q)) {
        keep.add(i);
        e.ancestors.forEach((a) => keep.add(a));
      }
    });
    return entries.filter((_, i) => keep.has(i));
  }, [entries, query]);

  const selectedLabel = React.useMemo(() => {
    if (!value) return null;
    const loc = locations.find((l) => l.id === value);
    if (!loc) return null;
    const parent = loc.parent_location_id
      ? locations.find((l) => l.id === loc.parent_location_id)
      : null;
    return parent ? `${parent.location_name} › ${loc.location_name}` : loc.location_name;
  }, [value, locations]);

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-bg-elev px-2.5 text-sm text-text shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className={cn('truncate text-left', !selectedLabel && 'text-text-3')}>
            {selectedLabel ?? placeholder}
          </span>
          <ChevronDown size={14} className="shrink-0 text-text-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-[16rem]">
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            icon={Search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
          />
        </div>
        <div className="max-h-60 overflow-y-auto p-1" role="listbox" aria-label={ariaLabel}>
          {visible.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-text-3">No locations.</p>
          ) : (
            visible.map((e, i) =>
              e.id ? (
                <button
                  key={`${e.id}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={e.id === value}
                  onClick={() => {
                    onChange(e.id!);
                    setOpen(false);
                    setQuery('');
                  }}
                  style={{ paddingLeft: `${e.depth * 14 + 8}px` }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded py-1.5 pr-2 text-left text-sm hover:bg-surface',
                    e.id === value && 'bg-surface',
                  )}
                >
                  <Check
                    size={14}
                    className={cn('shrink-0', e.id === value ? 'text-accent' : 'invisible')}
                    aria-hidden
                  />
                  <span className="min-w-0 truncate">{e.label}</span>
                </button>
              ) : (
                <div
                  key={`h-${i}`}
                  style={{ paddingLeft: `${e.depth * 14 + 8}px` }}
                  className={cn(
                    'select-none py-1.5 pr-2 text-left',
                    e.depth === 0
                      ? 'text-[11px] font-semibold uppercase tracking-wider text-text-3'
                      : 'text-xs font-medium text-text-2',
                  )}
                >
                  {e.label}
                </div>
              ),
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
