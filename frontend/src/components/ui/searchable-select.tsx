'use client';

import * as React from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface SearchableSelectOption {
  value: string;
  /** Rendered in the trigger (when selected) and in the option list. */
  label: React.ReactNode;
  /** Free text the typed query is matched against (case-insensitive). */
  searchText: string;
}

interface Props {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  className?: string;
}

/**
 * Single-select dropdown with a search box — the searchable counterpart to the
 * plain Radix {@link Select}, modelled on {@link VendorMultiSelect}. Use it
 * anywhere a picklist can grow long (items, vendors, …). The trigger shows the
 * selected option's label; the popover filters options by ``searchText``.
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches.',
  disabled,
  id,
  className,
  'aria-label': ariaLabel,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const selected = React.useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.searchText.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <Popover
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
          className={cn(
            'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-bg-elev px-2.5 text-sm text-text shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('truncate text-left', !selected && 'text-text-3')}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown size={14} className="shrink-0 text-text-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[16rem]"
      >
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            icon={Search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
          />
        </div>
        <div
          className="max-h-56 overflow-y-auto p-1"
          role="listbox"
          aria-label={ariaLabel}
        >
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-text-3">{emptyText}</p>
          ) : (
            filtered.map((o) => {
              const isSelected = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                    setQuery('');
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface',
                    isSelected && 'bg-surface',
                  )}
                >
                  <Check
                    size={14}
                    className={cn('shrink-0', isSelected ? 'text-accent' : 'invisible')}
                    aria-hidden
                  />
                  <span className="min-w-0 truncate">{o.label}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
