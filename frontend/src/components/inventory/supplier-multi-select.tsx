'use client';

import * as React from 'react';
import { ChevronDown, Search } from 'lucide-react';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { Supplier } from '@/lib/api/suppliers';

interface Props {
  suppliers: Supplier[];
  /** Selected supplier ids. */
  value: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  id?: string;
  /**
   * Render the popover as a modal. Set this when used inside a Dialog/Sheet so
   * the list can be wheel-scrolled: a modal popover owns its own scroll-lock and
   * becomes the topmost lock, whereas a non-modal popover portals outside the
   * Dialog's lock and its list freezes. Leave false for page-level use.
   */
  modal?: boolean;
}

/**
 * Searchable multi-select dropdown of suppliers for an item's assigned-supplier
 * set. These are the suppliers an item can later be received against. Zero-or-more
 * may be picked. The trigger shows the chosen names (and a count); the popover
 * holds a search box over a checkable list, so it scales as the supplier master
 * data grows.
 */
export function SupplierMultiSelect({
  suppliers,
  value,
  onChange,
  loading,
  error,
  disabled,
  id,
  modal = false,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const selected = React.useMemo(() => new Set(value), [value]);

  const toggle = (supplierId: string) => {
    if (selected.has(supplierId)) onChange(value.filter((v) => v !== supplierId));
    else onChange([...value, supplierId]);
  };

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter((v) => v.name.toLowerCase().includes(q));
  }, [suppliers, query]);

  // Names of the currently-selected suppliers, for the trigger label.
  const selectedNames = React.useMemo(
    () => suppliers.filter((v) => selected.has(v.id)).map((v) => v.name),
    [suppliers, selected],
  );

  if (loading) {
    return (
      <div className="rounded-md border border-border px-3 py-2.5 text-xs text-text-2">
        Loading suppliers…
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
  if (suppliers.length === 0) {
    return (
      <div className="rounded-md border border-border px-3 py-2.5 text-xs text-text-2">
        No suppliers available. Create a supplier first.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Popover
        modal={modal}
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
              className={cn(
                'min-w-0 flex-1 truncate text-left',
                selectedNames.length === 0 && 'text-text-3',
              )}
            >
              {selectedNames.length === 0
                ? 'Select suppliers…'
                : selectedNames.length <= 2
                  ? selectedNames.join(', ')
                  : `${selectedNames.length} suppliers selected`}
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
              placeholder="Search suppliers…"
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1" role="group" aria-label="Suppliers">
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
          ? 'No suppliers selected — you can add them later.'
          : `${value.length} supplier${value.length === 1 ? '' : 's'} selected`}
      </p>
    </div>
  );
}
