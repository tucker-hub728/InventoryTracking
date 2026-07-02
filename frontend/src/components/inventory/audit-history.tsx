'use client';

import * as React from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Edit3,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { cn } from '@/lib/utils';
import { mockData } from '@/lib/mock-data';
import type { InventoryItem, Signoff } from '@/types';

// ───────── Types ─────────

type EventKind = 'in' | 'out' | 'edit' | 'warning';

interface AuditEntry {
  id: string;
  kind: EventKind;
  title: string;
  body: React.ReactNode;
  /** Attribution row chips (user, role, lot, reason, etc.) */
  meta: Array<{ key: string; value: React.ReactNode; muted?: boolean }>;
  /** When present, renders the signature card at the bottom of the entry. */
  signature?: {
    user: string;
    dataUrl: string;
    date: string;
    time: string;
  };
  date: string;
  time: string;
  /** "Signed" badge tone when this entry represents a signed action. */
  signed?: boolean;
}

// ───────── Visual config ─────────

const KIND_STYLE: Record<
  EventKind,
  { icon: LucideIcon; circle: string; iconClass: string }
> = {
  in: {
    icon: ArrowDownLeft,
    circle: 'border-success/40 bg-success-soft',
    iconClass: 'text-success',
  },
  out: {
    icon: ArrowUpRight,
    circle: 'border-warning/40 bg-warning-soft',
    iconClass: 'text-warning',
  },
  edit: {
    icon: Edit3,
    circle: 'border-accent/40 bg-accent-soft',
    iconClass: 'text-accent',
  },
  warning: {
    icon: AlertTriangle,
    circle: 'border-warning/40 bg-warning-soft',
    iconClass: 'text-warning',
  },
};

// ───────── Build entries for an item ─────────

function splitDateTime(ts: string): { date: string; time: string } {
  const parts = ts.split(' ');
  return { date: parts[0] ?? ts, time: parts[1] ?? '' };
}

/**
 * Synthesize an audit history for the given item by combining:
 *   - the recycled demo sign-off records (used as Stock In/Out signed cards)
 *   - a generated metadata-change event
 *   - a generated lot-expiry warning event
 *
 * In a production app this would come from a dedicated /audit-events
 * endpoint keyed by item ID.
 */
function buildEntries(item: InventoryItem, signoffs: Signoff[]): AuditEntry[] {
  const out: AuditEntry[] = [];

  signoffs.forEach((s, i) => {
    const { date, time } = splitDateTime(s.date);
    const kind: EventKind = s.direction === 'in' ? 'in' : 'out';
    const verb = s.direction === 'in' ? 'Unit in' : 'Unit out';
    const action = s.direction === 'in' ? 'Received' : 'Released';
    const subject =
      s.direction === 'in'
        ? `${s.units} units from supplier (PO #4421)`
        : `${s.units} units for manufacturing run M-2026-031`;

    const balanceFrom = 16 + i * 3;
    const balanceTo =
      s.direction === 'in' ? balanceFrom + s.units : balanceFrom - s.units;

    out.push({
      id: s.id,
      kind,
      title: `${verb} signed`,
      signed: true,
      body: (
        <>
          {action} <strong>{s.units} units</strong>
          {s.direction === 'in' ? ' from supplier (PO #4421)' : ` for ${s.reason}`}.{' '}
          Balance moved {balanceFrom} → {balanceTo}.
        </>
      ),
      meta: [
        { key: 'user', value: s.user },
        { key: 'role', value: s.role, muted: true },
        { key: 'lot', value: `Lot ${s.lot}`, muted: true },
        { key: 'reason', value: `Reason: ${s.reason}`, muted: true },
      ],
      signature: { user: s.user, dataUrl: s.signature, date, time },
      date,
      time,
    });
    // suppress unused subject warning while keeping the variable for future copy variations
    void subject;
  });

  // Demo metadata-update event positioned between sign-offs.
  out.push({
    id: `${item.id}-meta-1`,
    kind: 'edit',
    title: 'Item metadata updated',
    signed: true,
    body: (
      <>
        Reorder threshold raised from <strong>{Math.max(1, item.threshold - 3)} → {item.threshold}</strong>{' '}
        to reflect updated forecast.
      </>
    ),
    meta: [
      { key: 'user', value: 'Amelia Chen' },
      { key: 'role', value: 'Administrator', muted: true },
      { key: 'field', value: 'Field: threshold', muted: true },
    ],
    signature: {
      user: 'Amelia Chen',
      dataUrl: signoffs[0]?.signature ?? '',
      date: '2026-05-12',
      time: '16:04',
    },
    date: '2026-05-12',
    time: '16:04',
  });

  // Demo expiry warning event.
  out.push({
    id: `${item.id}-warn-1`,
    kind: 'warning',
    title: 'Lot expiry warning raised',
    body: (
      <>
        Lot <span className="font-mono">{item.lot !== '—' ? item.lot : 'L-20264861'}</span>{' '}
        approaching expiry on <strong>{item.expires !== '—' ? item.expires : '2026-08-01'}</strong>.
        System notification queued.
      </>
    ),
    meta: [
      { key: 'src', value: 'System', muted: true },
      { key: 'sev', value: 'Severity: warning', muted: true },
    ],
    date: '2026-04-29',
    time: '11:22',
  });

  // Sort by date+time descending.
  return out.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
}

// ───────── Component ─────────

export function AuditHistory({ item }: { item: InventoryItem }) {
  const entries = React.useMemo(
    () => buildEntries(item, mockData.signoffs),
    [item],
  );

  if (entries.length === 0) {
    return (
      <EmptyState title="No audit events" hint="Signed actions will appear here." />
    );
  }

  return (
    <ol className="relative space-y-3 py-2 pl-10 pr-2">
      {/* Connecting vertical line behind the circles */}
      <span
        aria-hidden
        className="absolute left-[18px] top-3 bottom-3 w-px bg-border"
      />
      {entries.map((e) => (
        <AuditRow key={e.id} entry={e} />
      ))}
    </ol>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const style = KIND_STYLE[entry.kind];
  const Icon = style.icon;
  return (
    <li className="relative">
      <span
        aria-hidden
        className={cn(
          'absolute -left-[26px] top-3 grid size-6 place-items-center rounded-full border-2 border-bg ring-1',
          style.circle,
        )}
      >
        <span className={style.iconClass}>
          <Icon size={12} />
        </span>
      </span>

      <Card className="px-4 py-3 shadow-elev-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-text">{entry.title}</h3>
              {entry.signed && (
                <Badge tone="accent">
                  <ShieldCheck size={10} className="mr-1" aria-hidden /> Signed
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm leading-snug text-text-2">{entry.body}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {entry.meta.map((m, i) => (
                <React.Fragment key={`${entry.id}-m-${i}`}>
                  {i > 0 && (
                    <span aria-hidden className="text-text-3">
                      ·
                    </span>
                  )}
                  <span className={m.muted ? 'text-text-3' : 'font-medium text-text-2'}>
                    {m.value}
                  </span>
                </React.Fragment>
              ))}
            </div>
          </div>
          <div className="shrink-0 text-right font-mono text-[11px] leading-tight text-text-3">
            <div>{entry.date}</div>
            <div>· {entry.time}</div>
          </div>
        </div>

        {entry.signature && entry.signature.dataUrl && (
          <div className="mt-3 border-t border-dashed border-border pt-3">
            <div className="flex items-start gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={entry.signature.dataUrl}
                alt={`Electronic signature of ${entry.signature.user}`}
                className="h-10 max-w-[160px] rounded border border-border bg-bg p-1"
              />
              <div className="min-w-0 flex-1 text-xs">
                <div className="font-medium text-text">
                  Electronically signed by {entry.signature.user}
                </div>
                <div className="mt-0.5 font-mono text-text-3">
                  {entry.signature.date} · {entry.signature.time}
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>
    </li>
  );
}
