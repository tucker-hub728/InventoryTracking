'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowRightLeft,
  ArrowUpFromLine,
  Factory,
  History,
  Pencil,
  Plus,
  Scale,
  ShieldCheck,
  Trash2,
  Truck,
  Undo2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useMinDuration } from '@/hooks/use-min-duration';
import { EmptyState } from '@/components/shared/empty-state';
import { TableSkeleton } from '@/components/shared/table-skeleton';
import { ReleaseStateBadge } from '@/components/inventory/release-state-badge';
import type { LotReleaseState } from '@/lib/api/lots';
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
import {
  kitsApi,
  KIT_OPERATION_LABEL,
  type ApiItemKitAuditEvent,
} from '@/lib/api/kits';
import { LotLink } from '@/components/inventory/lot-link';
import { cn } from '@/lib/utils';

import { AuditDetailSheet } from './audit-detail-sheet';
import { MovementDetailSheet } from './movement-detail-sheet';

interface Props {
  subjectTable: ApiAuditSubjectTable;
  subjectId: string;
  /** Cap on audit-event rows. Movements are unbounded (500-row v1 cap). */
  limit?: number;
  /** When set (built AY/FG items), also merge the kitting/reconciliation audit
   *  events for every kit this item took part in (AUD-001) — good/scrap made,
   *  components consumed, output location — the detail that never moves stock. */
  kitAuditItemId?: string;
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
  // Kitting / back-flush. Issues leave stock (warning, out-arrow); production
  // output and back-flush return it (success, in-arrow).
  kit_issue: {
    Icon: ArrowUpFromLine,
    tint: 'text-warning',
    pill: 'border-warning/30 bg-warning/5 text-warning',
  },
  kit_additional_issue: {
    Icon: ArrowUpFromLine,
    tint: 'text-warning',
    pill: 'border-warning/30 bg-warning/5 text-warning',
  },
  production_output: {
    Icon: ArrowDownToLine,
    tint: 'text-success',
    pill: 'border-success/30 bg-success/5 text-success',
  },
  backflush: {
    Icon: ArrowDownToLine,
    tint: 'text-success',
    pill: 'border-success/30 bg-success/5 text-success',
  },
  // The other two return events (kitting05). A manual return is routine
  // (accent); a cancellation is worth flagging (warning).
  kit_return: {
    Icon: Undo2,
    tint: 'text-accent',
    pill: 'border-accent/30 bg-accent/5 text-accent',
  },
  kit_cancel_return: {
    Icon: Undo2,
    tint: 'text-warning',
    pill: 'border-warning/30 bg-warning/5 text-warning',
  },
  // Terminal customer shipment — stock leaves to a customer (unit-out).
  customer_shipment: {
    Icon: Truck,
    tint: 'text-warning',
    pill: 'border-warning/30 bg-warning/5 text-warning',
  },
  // Leaves the shelf for the floor — same "out" tint as a kit issue.
  consumable_issue: {
    Icon: ArrowUpFromLine,
    tint: 'text-warning',
    pill: 'border-warning/30 bg-warning/5 text-warning',
  },
  // Debit-and-gone to PD / R&D / QC (TRX-001/002). Leaves controlled inventory
  // for good, like a shipment — so it takes the shipment's tint rather than the
  // Kanban issue's, even though it shares that one's "into a named place" shape.
  material_issue: {
    Icon: ArrowUpFromLine,
    tint: 'text-warning',
    pill: 'border-warning/30 bg-warning/5 text-warning',
  },
};

// Kit audit operations → icon + tint (per-item history for built AY/FG items).
const KIT_OP_ICON: Record<string, IconStyle> = {
  create: { Icon: Plus, tint: 'text-success', pill: 'border-success/30 bg-success/5 text-success' },
  edit_kit: { Icon: Pencil, tint: 'text-text-2', pill: 'border-border bg-bg-elev text-text-2' },
  edit_line: { Icon: Pencil, tint: 'text-text-2', pill: 'border-border bg-bg-elev text-text-2' },
  issue: { Icon: ArrowUpFromLine, tint: 'text-warning', pill: 'border-warning/30 bg-warning/5 text-warning' },
  additional_issue: { Icon: ArrowUpFromLine, tint: 'text-warning', pill: 'border-warning/30 bg-warning/5 text-warning' },
  early_return: { Icon: Undo2, tint: 'text-accent', pill: 'border-accent/30 bg-accent/5 text-accent' },
  production_draft: { Icon: Factory, tint: 'text-accent', pill: 'border-accent/30 bg-accent/5 text-accent' },
  produce: { Icon: Factory, tint: 'text-success', pill: 'border-success/30 bg-success/5 text-success' },
  close_out: { Icon: Factory, tint: 'text-success', pill: 'border-success/30 bg-success/5 text-success' },
  cancel: { Icon: Trash2, tint: 'text-danger', pill: 'border-danger/30 bg-danger/5 text-danger' },
};
const KIT_OP_FALLBACK: IconStyle = {
  Icon: History,
  tint: 'text-text-2',
  pill: 'border-border bg-bg-elev text-text-2',
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
    }
  | {
      kind: 'kit';
      id: string;
      occurred_at: string;
      kit: ApiItemKitAuditEvent;
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
export function EntityAuditTimeline({ subjectTable, subjectId, limit = 100, kitAuditItemId }: Props) {
  const [entries, setEntries] = React.useState<TimelineEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Held briefly — the fetch returns in ~20ms, too fast to see otherwise.
  const showSkeleton = useMinDuration(loading);
  const [selectedAuditId, setSelectedAuditId] = React.useState<string | null>(null);
  const [selectedMovement, setSelectedMovement] = React.useState<ApiMovement | null>(null);

  React.useEffect(() => {
    if (!subjectId) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    const auditP = auditApi.list({ subjectTable, subjectId, limit }, { signal: ctrl.signal });
    // Only items live in the movement ledger; other subject tables
    // skip this fetch entirely.
    const ledgerP =
      subjectTable === 'app.items'
        ? movementsApi.listForItem(subjectId, { limit: 500 }, { signal: ctrl.signal })
        : Promise.resolve({ items: [] as ApiMovement[] });
    // Built items (AY/FG) also fold in the kitting/reconciliation audit events
    // for every kit they took part in (AUD-001) — good/scrap/consumed detail.
    const kitP =
      kitAuditItemId && subjectTable === 'app.items'
        ? kitsApi.itemAudit(kitAuditItemId, { signal: ctrl.signal })
        : Promise.resolve({ events: [] as ApiItemKitAuditEvent[] });
    // An item's history must include what was decided about its BATCHES —
    // release state above all (STS-002). Those events are recorded against the
    // lot, not the item, so filtering by the item's own id never finds them and
    // a release decision silently never appeared on this tab.
    const lotP =
      subjectTable === 'app.items'
        ? auditApi.list(
            { subjectTable: 'app.lots', lotsOfItem: subjectId, limit },
            { signal: ctrl.signal },
          )
        : Promise.resolve({ items: [] as ApiAuditEvent[] });

    Promise.all([auditP, ledgerP, kitP, lotP])
      .then(([auditResp, ledgerResp, kitResp, lotResp]) => {
        const moveTimes = new Set(
          ledgerResp.items.map((m) => new Date(m.performed_at).getTime()),
        );
        const kitEvents = kitResp.events.filter((k) => {
          // Only surface a kit event that actually involves THIS item: it either
          // physically moved the item (a movement shares its timestamp) or
          // consumed it (`consumed[]`). A kit's events about its OTHER components
          // — e.g. an additional issue of a different part — must NOT appear on
          // this item's history.
          const hasMovement = moveTimes.has(new Date(k.occurred_at).getTime());
          const inConsumed = k.consumed.some((c) => c.item_id === subjectId);
          if (!hasMovement && !inConsumed) return false;
          // Of the events that do involve this item, drop the ones that add no
          // stock-invisible detail (good / scrap / consumed / output) AND are
          // already shown by their coinciding movement (issue / return / cancel)
          // — keep produce / close-out, and consumed-only events (no movement).
          const hasDetail =
            k.good_qty != null ||
            k.scrap_qty != null ||
            k.consumed.length > 0 ||
            Boolean(k.output_location);
          return hasDetail || !hasMovement;
        });
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
          // Lot events, folded in as ordinary audit entries. Only the ones that
          // changed something a reader of the ITEM cares about: a lot's own
          // creation and its expiry edits already show through the ledger and
          // the lot page, whereas a release decision has nowhere else to appear.
          ...lotResp.items
            .filter((e) => Boolean(e.diff?.release_state))
            .map<TimelineEntry>((e) => ({
              kind: 'audit',
              id: `l:${e.id}`,
              occurred_at: e.occurred_at,
              event: e,
            })),
          ...kitEvents.map<TimelineEntry>((k) => ({
            kind: 'kit',
            id: `k:${k.id}`,
            occurred_at: k.occurred_at,
            // This is a PER-ITEM history, so the consumed line shows only THIS
            // item's consumption — the whole-batch recipe lives in the kit's own
            // Activity log. (On the built item's own audit this is empty; its
            // "N made" + output location carry the meaning.)
            kit: { ...k, consumed: k.consumed.filter((c) => c.item_id === subjectId) },
          })),
        ];
        merged.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
        setEntries(merged);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load audit history.');
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [subjectTable, subjectId, limit, kitAuditItemId]);

  if (showSkeleton) {
    return <TableSkeleton rows={5} columns={4} label="Loading audit history…" />;
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
        <span aria-hidden className="absolute bottom-3 left-[27px] top-3 w-px bg-border" />
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
        // This timeline already fetched the full ledger row to render the
        // list, so hand it over rather than making the sheet re-fetch it.
        movementId={selectedMovement?.id ?? null}
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
  if (entry.kind === 'kit') {
    return <KitEventRow event={entry.kit} index={index} />;
  }
  // A release decision is the one audit event on this page that a reader is
  // usually LOOKING for, and the generic row buries it: "Updated ·
  // inventory.lot.updated · 1 field changed" is true and unreadable, and in a
  // list of eighty rows it is invisible. Show the transition itself.
  if (entry.event.diff?.release_state) {
    return (
      <ReleaseRow
        event={entry.event}
        index={index}
        onSelect={() => onSelectAudit(entry.event.id)}
      />
    );
  }
  return (
    <AuditRow event={entry.event} index={index} onSelect={() => onSelectAudit(entry.event.id)} />
  );
}

/** A kitting / reconciliation audit event on the item's per-item history — the
 *  good/scrap/consumed/output detail that never moves stock, labelled + linked
 *  to its kit. Back-flush returns appear here as their kit's `close_out` /
 *  `early_return` entries (reconciliation). */
function KitEventRow({ event, index }: { event: ApiItemKitAuditEvent; index: number }) {
  const style = KIT_OP_ICON[event.operation] ?? KIT_OP_FALLBACK;
  const { Icon } = style;
  const label = KIT_OPERATION_LABEL[event.operation] ?? event.operation;
  const hasYield = event.good_qty != null || (event.scrap_qty ?? 0) > 0;

  return (
    <li className="group relative flex items-start gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
      <RowIcon Icon={Icon} pillClass={style.pill} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-text-1 text-sm font-medium">{label}</span>
          {event.kit_number && event.kit_id && (
            <Link
              href={`/reconciliation/${event.kit_id}`}
              className="rounded-sm font-mono text-[11px] font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {event.kit_number}
            </Link>
          )}
          {hasYield && (
            <span className={cn('font-mono text-xs font-semibold', style.tint)}>
              {event.good_qty ?? 0} made
              {(event.scrap_qty ?? 0) > 0 && (
                <span className="text-danger"> · {event.scrap_qty} scrapped</span>
              )}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-text-3">
          <span className="font-mono">{formatTime(event.occurred_at)}</span>
          {event.output_location && (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono">stocked to {event.output_location}</span>
            </>
          )}
          {event.output_expiration_date && (
            <>
              <span aria-hidden>·</span>
              <span>expires {event.output_expiration_date}</span>
            </>
          )}
        </div>
        {event.consumed.length > 0 && (
          <p className="mt-1 text-xs text-text-2">
            Consumed:{' '}
            {event.consumed.map((c, i) => (
              <span key={c.item_id + i} className="font-mono">
                {i > 0 && ', '}
                <span className="text-text-3">−{c.qty}</span> {c.item_number}
              </span>
            ))}
          </p>
        )}
      </div>
      {event.signature_id && <ESignedBadge />}
      <span className="font-mono text-[10px] text-text-3">#{index}</span>
    </li>
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
    // A customer shipment leaves inventory TO a customer (CUST-001) — show the
    // named customer as the destination, not just the source shelf.
    if (movement.movement_type === 'customer_shipment') {
      const cust = movement.customer_name ?? 'Catalog (no customer)';
      return fromCode ? `from ${fromCode} → ${cust}` : `→ ${cust}`;
    }
    // An issue also leaves inventory, but its destination IS a location, so the
    // plain "from → to" below would read as a transfer. Say where it went out
    // to, so nobody mistakes the destination for a place holding stock.
    if (movement.movement_type === 'material_issue') {
      const dest = toCode ?? 'a location';
      return fromCode ? `from ${fromCode} → out to ${dest}` : `→ out to ${dest}`;
    }
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
          <span className="text-text-1 text-sm font-medium">{typeLabel}</span>
          <span className={cn('font-mono text-xs font-semibold', style.tint)}>
            {sign}
            {qtyAbs}
          </span>
          {movement.lot_number && (
            <span className="font-mono text-[11px] text-text-3">
              lot <LotLink lotId={movement.lot_id} lotNumber={movement.lot_number} />
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
          {movement.kit_number && movement.kit_id && (
            <>
              <span aria-hidden>·</span>
              <Link
                href={`/reconciliation/${movement.kit_id}`}
                onClick={(e) => e.stopPropagation()}
                className="rounded-sm font-mono text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {movement.kit_number}
              </Link>
            </>
          )}
          {/* Reference / tracking number on a customer shipment (TRX-005). */}
          {movement.reference_number && (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono">Ref {movement.reference_number}</span>
            </>
          )}
        </div>
        {movement.notes && <p className="mt-1 text-xs text-text-2">{movement.notes}</p>}
      </div>
      {movement.reauth_evidence_id && <ESignedBadge />}
      <span className="font-mono text-[10px] text-text-3">#{index}</span>
    </li>
  );
}

const RELEASE_STATES: readonly string[] = ['quarantine', 'qc_hold', 'released', 'rejected'];

function asReleaseState(value: unknown): LotReleaseState | null {
  return typeof value === 'string' && RELEASE_STATES.includes(value)
    ? (value as LotReleaseState)
    : null;
}

/** A batch's release decision on the item's history (REQ-2026-07-31-STS-002).
 *
 *  These live on the LOT, not the item, so they reach this timeline through the
 *  ``lots_of_item`` filter. Rendered as the transition — ``Quarantine →
 *  Rejected`` — with the batch named, because "which batch, from what, to what"
 *  is the whole content of the event and the generic row shows none of it. */
function ReleaseRow({
  event,
  index,
  onSelect,
}: {
  event: ApiAuditEvent;
  index: number;
  onSelect: () => void;
}) {
  const change = event.diff?.release_state;
  const from = asReleaseState(change?.before);
  const to = asReleaseState(change?.after);

  return (
    <li
      onClick={onSelect}
      className="group relative flex cursor-pointer items-start gap-3 rounded-md border border-border bg-surface px-3 py-2.5 transition-colors hover:bg-bg-elev"
    >
      <RowIcon Icon={ShieldCheck} pillClass="border-accent/30 bg-accent-soft text-accent" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-text-1 text-sm font-medium">Quality status</span>
          {from && <ReleaseStateBadge state={from} size="xs" />}
          {from && <ArrowRight size={12} className="shrink-0 text-text-3" />}
          {to && <ReleaseStateBadge state={to} size="xs" />}
          {event.subject_label && (
            <span className="font-mono text-[11px] text-text-3">{event.subject_label}</span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-text-3">
          <span className="font-mono">{formatTime(event.occurred_at)}</span>
          <span aria-hidden>·</span>
          <span>{event.actor_user_name ?? event.actor_kind}</span>
        </div>
      </div>
      {event.signature_id && <ESignedBadge />}
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
  const style = AUDIT_ACTION_ICON[event.action as ApiAuditAction] ?? AUDIT_ACTION_ICON.updated;
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
          <span className="text-text-1 text-sm font-medium">
            {AUDIT_ACTION_LABEL[event.action as ApiAuditAction] ?? event.action}
          </span>
          <span className="font-mono text-[11px] text-text-3">{event.event_type}</span>
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

function RowIcon({ Icon, pillClass }: { Icon: LucideIcon; pillClass: string }) {
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
