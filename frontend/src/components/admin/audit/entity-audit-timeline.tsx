'use client';

import * as React from 'react';
import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  History,
  Loader2,
  Pencil,
  Plus,
  Scale,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import {
  auditApi,
  type ApiAuditAction,
  type ApiAuditEvent,
  type ApiAuditSubjectTable,
  AUDIT_ACTION_LABEL,
} from '@/lib/api/audit';
import { ApiError } from '@/lib/api/client';
import {
  movementsApi,
  MOVEMENT_TYPE_LABEL,
  type ApiMovement,
  type MovementType,
} from '@/lib/api/movements';
import { cn } from '@/lib/utils';

import { AuditDetailSheet } from './audit-detail-sheet';
import { MovementDetailSheet } from './movement-detail-sheet';

interface Props {
  subjectTable: ApiAuditSubjectTable;
  subjectId: string;
  /** Cap on audit-event rows. Movements are unbounded (500-row v1 cap). */
  limit?: number;
}

// ── Per-event icon + tint ───────────────────────────────────────────────

interface IconStyle {
  Icon: LucideIcon;
  tint: string;
  pill: string;
}

const MOVEMENT_ICON: Record<MovementType, IconStyle> = {
  receipt: {
    Icon: ArrowDownToLine,
    tint: 'text-success',
    pill: 'border-success/30 bg-success/5 text-success',
  },
  transfer_in: {
    Icon: ArrowRightLeft,
    tint: 'text-accent',
    pill: 'border-accent/30 bg-accent/5 text-accent',
  },
  dispense: {
    Icon: ArrowUpFromLine,
    tint: 'text-warning',
    pill: 'border-warning/30 bg-warning/5 text-warning',
  },
  discard: {
    Icon: Trash2,
    tint: 'text-danger',
    pill: 'border-danger/30 bg-danger/5 text-danger',
  },
  transfer_out: {
    Icon: ArrowRightLeft,
    tint: 'text-warning',
    pill: 'border-warning/30 bg-warning/5 text-warning',
  },
  adjustment: {
    Icon: Scale,
    tint: 'text-accent',
    pill: 'border-accent/30 bg-accent/5 text-accent',
  },
};

const AUDIT_ACTION_ICON: Record<ApiAuditAction, IconStyle> = {
  created: {
    Icon: Plus,
    tint: 'text-success',
    pill: 'border-success/30 bg-success/5 text-success',
  },
  updated: {
    Icon: Pencil,
    tint: 'text-text-2',
    pill: 'border-border bg-bg-elev text-text-2',
  },
  deleted: {
    Icon: Trash2,
    tint: 'text-danger',
    pill: 'border-danger/30 bg-danger/5 text-danger',
  },
  restored: {
    Icon: History,
    tint: 'text-success',
    pill: 'border-success/30 bg-success/5 text-success',
  },
};

// ── Unified timeline shape ──────────────────────────────────────────────

type TimelineEntry =
  | {
      kind: 'movement';
      id: string;
      occurred_at: string;
      movement: ApiMovement;
    }
  | {
      kind: 'audit';
      id: string;
      occurred_at: string;
      event: ApiAuditEvent;
    };

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Unified per-entity audit timeline. For items, the feed merges:
 *
 *   * Movement rows (receipt / dispense / discard / adjustment /
 *     transfer / reverse) from ``items/{id}/ledger``, and
 *   * Master-data edits (description / supplier / threshold / etc.)
 *     from ``audit/events?subject_table=app.items&subject_id=<id>``.
 *
 * For non-item subjects (suppliers, locations, lots), only audit events
 * are fetched — those entities don't appear in the movement ledger.
 *
 * Each row carries the appropriate icon + colour tint. When the row
 * has an associated e-signature (movements via ``reauth_evidence_id``,
 * audit events via ``signature_id``), an "e-signed" badge marks it.
 * Clicking an audit row opens the side-sheet with the field-level diff,
 * the recorded reason, and forensic snapshots.
 */
export function EntityAuditTimeline({
  subjectTable,
  subjectId,
  limit = 100,
}: Props) {
  const [entries, setEntries] = React.useState<TimelineEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedAuditId, setSelectedAuditId] = React.useState<string | null>(null);
  const [selectedMovement, setSelectedMovement] =
    React.useState<ApiMovement | null>(null);

  React.useEffect(() => {
    if (!subjectId) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    const auditP = auditApi.list(
      { subjectTable, subjectId, limit },
      { signal: ctrl.signal },
    );
    // Only items live in the movement ledger; other subject tables
    // skip this fetch entirely.
    const ledgerP =
      subjectTable === 'app.items'
        ? movementsApi.listForItem(subjectId, { limit: 500 }, { signal: ctrl.signal })
        : Promise.resolve({ items: [] as ApiMovement[] });

    Promise.all([auditP, ledgerP])
      .then(([auditResp, ledgerResp]) => {
        const merged: TimelineEntry[] = [
          ...ledgerResp.items.map<TimelineEntry>((m) => ({
            kind: 'movement',
            id: `m:${m.id}`,
            occurred_at: m.performed_at,
            movement: m,
          })),
          ...auditResp.items.map<TimelineEntry>((e) => ({
            kind: 'audit',
            id: `a:${e.id}`,
            occurred_at: e.occurred_at,
            event: e,
          })),
        ];
        merged.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
        setEntries(merged);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(
          err instanceof ApiError ? err.message : 'Failed to load audit history.',
        );
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [subjectTable, subjectId, limit]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-10 text-sm text-text-3"
        role="status"
      >
        <Loader2 size={14} className="animate-spin" /> Loading audit history…
      </div>
    );
  }

  if (error) {
    return <EmptyState title="Couldn't load audit history" hint={error} />;
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No audit events yet"
        hint="Edits and signed actions will appear here as they happen."
      />
    );
  }

  return (
    <>
      <ol className="relative space-y-3 px-4 py-3">
        {/* Vertical rail behind the icons. */}
        <span
          aria-hidden
          className="absolute bottom-3 left-[27px] top-3 w-px bg-border"
        />
        {entries.map((entry, i) => (
          <TimelineRow
            key={entry.id}
            entry={entry}
            index={entries.length - i}
            onSelectAudit={(id) => setSelectedAuditId(id)}
            onSelectMovement={(m) => setSelectedMovement(m)}
          />
        ))}
      </ol>

      <AuditDetailSheet
        open={selectedAuditId !== null}
        onOpenChange={(o) => {
          if (!o) setSelectedAuditId(null);
        }}
        eventId={selectedAuditId}
      />

      <MovementDetailSheet
        open={selectedMovement !== null}
        onOpenChange={(o) => {
          if (!o) setSelectedMovement(null);
        }}
        movement={selectedMovement}
      />
    </>
  );
}

// ── One row ─────────────────────────────────────────────────────────────

function TimelineRow({
  entry,
  index,
  onSelectAudit,
  onSelectMovement,
}: {
  entry: TimelineEntry;
  index: number;
  onSelectAudit: (id: string) => void;
  onSelectMovement: (m: ApiMovement) => void;
}) {
  if (entry.kind === 'movement') {
    return (
      <MovementRow
        movement={entry.movement}
        index={index}
        onSelect={() => onSelectMovement(entry.movement)}
      />
    );
  }
  return (
    <AuditRow
      event={entry.event}
      index={index}
      onSelect={() => onSelectAudit(entry.event.id)}
    />
  );
}

function MovementRow({
  movement,
  index,
  onSelect,
}: {
  movement: ApiMovement;
  index: number;
  onSelect: () => void;
}) {
  const style = MOVEMENT_ICON[movement.movement_type];
  const { Icon } = style;
  const typeLabel = MOVEMENT_TYPE_LABEL[movement.movement_type];
  const fromCode = movement.from_location_node_name;
  const toCode = movement.to_location_node_name;
  const locText = (() => {
    if (fromCode && toCode) return `${fromCode} → ${toCode}`;
    if (toCode) return `into ${toCode}`;
    if (fromCode) return `from ${fromCode}`;
    return '';
  })();
  const qtyAbs = Number(movement.qty_abs).toLocaleString();
  const qtyDelta = Number(movement.qty_delta);
  const sign = qtyDelta > 0 ? '+' : qtyDelta < 0 ? '−' : '';

  return (
    <li
      onClick={onSelect}
      className="group relative flex cursor-pointer items-start gap-3 rounded-md border border-border bg-surface px-3 py-2.5 transition-colors hover:bg-bg-elev"
    >
      <RowIcon Icon={Icon} pillClass={style.pill} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-text-1">{typeLabel}</span>
          <span className={cn('font-mono text-xs font-semibold', style.tint)}>
            {sign}
            {qtyAbs}
          </span>
          {movement.lot_number && (
            <span className="font-mono text-[11px] text-text-3">
              lot {movement.lot_number}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-text-3">
          <span className="font-mono">{formatTime(movement.performed_at)}</span>
          <span aria-hidden>·</span>
          <span>by {movement.performed_by_user_name ?? 'unknown'}</span>
          {locText && (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono">{locText}</span>
            </>
          )}
        </div>
        {movement.notes && (
          <p className="mt-1 text-xs text-text-2">
            {movement.notes}
          </p>
        )}
      </div>
      {movement.reauth_evidence_id && <ESignedBadge />}
      <span className="font-mono text-[10px] text-text-3">#{index}</span>
    </li>
  );
}

function AuditRow({
  event,
  index,
  onSelect,
}: {
  event: ApiAuditEvent;
  index: number;
  onSelect: () => void;
}) {
  const style =
    AUDIT_ACTION_ICON[event.action as ApiAuditAction] ?? AUDIT_ACTION_ICON.updated;
  const { Icon } = style;
  const diffCount = event.diff ? Object.keys(event.diff).length : 0;

  return (
    <li
      onClick={onSelect}
      className="group relative flex cursor-pointer items-start gap-3 rounded-md border border-border bg-surface px-3 py-2.5 transition-colors hover:bg-bg-elev"
    >
      <RowIcon Icon={Icon} pillClass={style.pill} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-text-1">
            {AUDIT_ACTION_LABEL[event.action as ApiAuditAction] ?? event.action}
          </span>
          <span className="font-mono text-[11px] text-text-3">
            {event.event_type}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-text-3">
          <span className="font-mono">{formatTime(event.occurred_at)}</span>
          <span aria-hidden>·</span>
          <span>{event.actor_user_name ?? event.actor_kind}</span>
          {diffCount > 0 && (
            <>
              <span aria-hidden>·</span>
              <span>
                {diffCount} field{diffCount === 1 ? '' : 's'} changed
              </span>
            </>
          )}
        </div>
      </div>
      {event.signature_id && <ESignedBadge />}
      <span className="font-mono text-[10px] text-text-3">#{index}</span>
    </li>
  );
}

function RowIcon({
  Icon,
  pillClass,
}: {
  Icon: LucideIcon;
  pillClass: string;
}) {
  return (
    <span
      className={cn(
        'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border',
        pillClass,
      )}
      aria-hidden
    >
      <Icon size={14} />
    </span>
  );
}

/** Marks a timeline row as electronically signed. The signature is the
 *  system-recorded re-auth (signer + timestamp + reason on the audit row);
 *  there is no hand-drawn image. */
function ESignedBadge() {
  return (
    <span
      className="ml-2 mt-0.5 shrink-0 self-start rounded-sm border border-border bg-bg-elev px-1.5 py-0.5 text-[10px] text-text-3"
      title="Electronically signed"
    >
      e-signed
    </span>
  );
}
