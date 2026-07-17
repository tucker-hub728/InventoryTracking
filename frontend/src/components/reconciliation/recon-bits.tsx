'use client';

import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import {
  EXPIRY_LABEL,
  EXPIRY_TONE,
  KIT_STATUS_LABEL,
  KIT_STATUS_TONE,
  expiryStateOf,
  itemOf,
  type ItemTier,
  type KitStatus,
} from './reconciliation-data';

const TIER_TONE: Record<ItemTier, 'neutral' | 'accent' | 'success'> = {
  CR: 'neutral',
  AY: 'accent',
  FG: 'success',
};

const TIER_LABEL: Record<ItemTier, string> = {
  CR: 'Raw material',
  AY: 'Sub-assembly',
  FG: 'Finished good',
};

export function TierBadge({ tier }: { tier: ItemTier }) {
  return (
    <Badge tone={TIER_TONE[tier]} title={TIER_LABEL[tier]}>
      {tier}
    </Badge>
  );
}

export function KitStatusBadge({ status }: { status: KitStatus }) {
  return (
    <Badge tone={KIT_STATUS_TONE[status]} dot>
      {KIT_STATUS_LABEL[status]}
    </Badge>
  );
}

export function ExpiryBadge({ itemId }: { itemId: string }) {
  const item = itemOf(itemId);
  const state = expiryStateOf(item);
  if (state === 'none') {
    return <span className="text-xs text-text-3">No expiry</span>;
  }
  return (
    <Badge tone={EXPIRY_TONE[state]} title={item.expires ?? undefined}>
      {EXPIRY_LABEL[state]}
    </Badge>
  );
}

/** Item number + description, the pairing used in every table here. */
export function ItemCell({ itemId, indent = 0 }: { itemId: string; indent?: number }) {
  const item = itemOf(itemId);
  return (
    <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: indent * 18 }}>
      <TierBadge tier={item.tier} />
      <div className="min-w-0">
        <div className="font-mono text-xs font-medium text-text">{item.id}</div>
        <div className="truncate text-xs text-text-3" title={item.desc}>
          {item.desc}
        </div>
      </div>
      {item.isConsumable && (
        <Badge
          tone="warning"
          title="Consumable — never a BOM component (Transaction Spec §4.3). Moved to a Kanban/lab location by a separate transaction and reconciled by periodic count; expiry is still tracked."
        >
          consumable
        </Badge>
      )}
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

/** Small stat block used across the kit tabs. */
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

export function LocationSelect({
  value,
  options,
  onChange,
  disabled,
  className,
  'aria-label': ariaLabel,
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  // Native select: the picker sits inside dense table rows where a Radix
  // popover would fight the horizontal scroll container.
  const opts = options.includes(value) ? options : [value, ...options];
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-7 w-full rounded-md border border-border-strong bg-bg-elev px-1.5 text-xs text-text outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:bg-surface disabled:opacity-60',
        className,
      )}
    >
      {opts.map((o) => (
        <option key={o} value={o}>
          {o}
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
