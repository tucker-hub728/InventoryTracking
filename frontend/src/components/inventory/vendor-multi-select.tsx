'use client';

import * as React from 'react';
import { ChevronDown, Search } from 'lucide-react';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { Vendor } from '@/lib/api/vendors';

interface Props {
  vendors: Vendor[];
  /** Selected vendor ids. */
  value: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  id?: string;
}

/**
 * Searchable multi-select dropdown of vendors for an item's assigned-vendor
 * set. These are the vendors an item can later be received against. Zero-or-more
 * may be picked. The trigger shows the chosen names (and a count); the popover
 * holds a search box over a checkable list, so it scales as the vendor master
 * data grows.
 */
export function VendorMultiSelect({
  vendors,
  value,
  onChange,
  loading,
  error,
  disabled,
  id,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const selected = React.useMemo(() => new Set(value), [value]);

  const toggle = (vendorId: string) => {
    if (selected.has(vendorId)) onChange(value.filter((v) => v !== vendorId));
    else onChange([...value, vendorId]);
  };

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) => v.name.toLowerCase().includes(q));
  }, [vendors, query]);

  // Names of the currently-selected vendors, for the trigger label.
  const selectedNames = React.useMemo(
    () => vendors.filter((v) => selected.has(v.id)).map((v) => v.name),
    [vendors, selected],
  );

  if (loading) {
    return (
      <div className="rounded-md border border-border px-3 py-2.5 text-xs text-text-2">
        Loading vendors…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2.5 text-xs text-danger">
        {error}
      </div>
    );
  }
  if (vendors.length === 0) {
    return (
      <div className="rounded-md border border-border px-3 py-2.5 text-xs text-text-2">
        No vendors available. Create a vendor first.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
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
            className={cn(
              'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-bg-elev px-2.5 text-sm text-text shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <span
              className={cn('truncate', selectedNames.length === 0 && 'text-text-3')}
            >
              {selectedNames.length === 0
                ? 'Select vendors…'
                : selectedNames.join(', ')}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {selectedNames.length > 0 && (
                <span className="rounded-full bg-accent/10 px-1.5 py-px text-[11px] font-medium text-accent">
                  {selectedNames.length}
                </span>
              )}
              <ChevronDown size={14} className="text-text-3" aria-hidden />
            </span>
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
              placeholder="Search vendors…"
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1" role="group" aria-label="Vendors">
            {filtered.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-text-3">No matches.</p>
            ) : (
              filtered.map((v) => {
                const checked = selected.has(v.id);
                return (
                  <label
                    key={v.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-sm hover:bg-surface',
                      checked && 'bg-surface',
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(v.id)}
                    />
                    <span className="truncate">{v.name}</span>
                  </label>
                );
              })
            )}
          </div>
          {value.length > 0 && (
            <div className="flex items-center justify-between border-t border-border px-2.5 py-1.5">
              <span className="text-xs text-text-3">{value.length} selected</span>
              <button
                type="button"
                className="text-xs text-text-3 hover:text-accent"
                onClick={() => onChange([])}
              >
                Clear all
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      <p className="text-xs text-text-3">
        {value.length === 0
          ? 'No vendors selected — you can add them later.'
          : `${value.length} vendor${value.length === 1 ? '' : 's'} selected`}
      </p>
    </div>
  );
}
