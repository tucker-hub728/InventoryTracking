'use client';

import * as React from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
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
 * Checkbox list of vendors for an item's assigned-vendor set. These are the
 * vendors an item can later be received against. Zero-or-more may be picked.
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
  const selected = React.useMemo(() => new Set(value), [value]);

  const toggle = (vendorId: string, checked: boolean) => {
    if (checked) {
      if (!selected.has(vendorId)) onChange([...value, vendorId]);
    } else {
      onChange(value.filter((v) => v !== vendorId));
    }
  };

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
      <ScrollArea className="max-h-44 rounded-md border border-border">
        <ul className="divide-y divide-border" id={id} role="group">
          {vendors.map((v) => {
            const checked = selected.has(v.id);
            return (
              <li key={v.id}>
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <Checkbox
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(c) => toggle(v.id, c === true)}
                  />
                  <span className="truncate">{v.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
      <p className="text-xs text-text-3">
        {value.length === 0
          ? 'No vendors selected — you can add them later.'
          : `${value.length} vendor${value.length === 1 ? '' : 's'} selected`}
      </p>
    </div>
  );
}
