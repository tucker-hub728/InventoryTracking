'use client';

import * as React from 'react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { KIT_STATUS_LABEL, KIT_STATUS_TONE, type KitStatus } from '@/lib/api/kits';
import { cn } from '@/lib/utils';

export function KitStatusBadge({ status }: { status: KitStatus }) {
  return (
    <Badge tone={KIT_STATUS_TONE[status]} dot>
      {KIT_STATUS_LABEL[status]}
    </Badge>
  );
}

/** Item number + description — the pairing used in every kit table.
 *
 *  With `itemId`, the number links to the item's Unit Ledger, matching how the
 *  BOM and where-used tables link. Every tier has a ledger tab now, so
 *  `/ledger` resolves for raw materials and built items alike. Without an id it
 *  renders as plain text rather than a control that can only fail. */
export function ItemCell({
  itemNumber,
  description,
  itemId,
  indent = 0,
  badge,
}: {
  itemNumber: string;
  description: string;
  itemId?: string | null;
  indent?: number;
  badge?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: indent * 18 }}>
      <div className="min-w-0">
        {itemId ? (
          <Link
            href={`/inventory/${itemId}/ledger`}
            onClick={(e) => e.stopPropagation()}
            className="rounded-sm font-mono text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {itemNumber}
          </Link>
        ) : (
          <div className="font-mono text-xs font-medium text-text">{itemNumber}</div>
        )}
        <div className="truncate text-xs text-text-3" title={description}>
          {description}
        </div>
      </div>
      {badge}
    </div>
  );
}

/** A labelled number, right-aligned, monospace — the quantity columns. */
export function QtyCell({
  value,
  tone,
  title,
}: {
  value: number | string | null;
  tone?: 'muted' | 'danger' | 'success';
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'font-mono text-xs tabular-nums',
        tone === 'muted' && 'text-text-3',
        tone === 'danger' && 'font-medium text-danger',
        tone === 'success' && 'font-medium text-success',
      )}
    >
      {value === null || value === '' ? '—' : value}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'default' | 'danger' | 'success' | 'warning';
}) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wider text-text-3">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-lg tabular-nums text-text',
          tone === 'danger' && 'text-danger',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-text-3">{hint}</div>}
    </div>
  );
}

/** Explains a doc rule inline, so the model is legible without the spec open. */
export function RuleNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-text-2">
      {children}
    </p>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export function LocationSelect({
  value,
  options,
  onChange,
  disabled,
  placeholder,
  className,
  'aria-label': ariaLabel,
}: {
  value: string | null;
  options: SelectOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-7 w-full rounded-md border border-border-strong bg-bg-elev px-1.5 text-xs text-text outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:bg-surface disabled:opacity-60',
        className,
      )}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function NumberInput({
  value,
  onChange,
  disabled,
  invalid,
  min = 0,
  className,
  'aria-label': ariaLabel,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  invalid?: boolean;
  min?: number;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={min}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      value={value ?? ''}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(raw === '' ? null : Number(raw));
      }}
      className={cn(
        'h-7 w-20 rounded-md border bg-bg-elev px-2 text-right font-mono text-xs tabular-nums text-text outline-none transition-colors focus:ring-2 disabled:cursor-not-allowed disabled:bg-surface disabled:opacity-60',
        invalid
          ? 'border-danger focus:border-danger focus:ring-danger/20'
          : 'border-border-strong focus:border-accent focus:ring-accent/20',
        className,
      )}
    />
  );
}

/** Formats an ISO timestamp for the activity log. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}
