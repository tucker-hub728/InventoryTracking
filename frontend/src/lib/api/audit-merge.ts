/**
 * Synthesise stock-movement rows into the ``ApiAuditEvent`` shape so
 * the audit viewer can render them in the same table as
 * ``audit.audit_events`` rows.
 *
 * Movements live in a separate physical table (``app.stock_movements``)
 * but they are still 21-CFR-Part-11 audit-worthy events — every signed
 * receipt / dispense / transfer is a record of who did what, when, and
 * to which lot. Showing them in the unified audit log is what the user
 * expects when they pick the "Movements" subject filter (or browse the
 * unfiltered timeline).
 *
 * A proper backend ``UNION ALL`` query is the long-term home for this
 * merge; for the v1 MVP we keep it in the client because:
 *   * No DB migration / schema cross-table juggling needed.
 *   * Movement volume is bounded (≤500 rows in MVP).
 *   * Per-row click-through is dispatched here too — synth rows carry
 *     ``subject_table='app.stock_movements'`` so the page can pick the
 *     movement detail sheet instead of the audit-event detail sheet.
 */

import type { ApiAuditEvent, ApiAuditSeverity } from './audit';
import type { ApiMovement } from './movements';

function severityFor(m: ApiMovement): ApiAuditSeverity {
  if (m.movement_type === 'discard') return 'warning';
  return 'info';
}

/** ``CM-0001 · CryoStor 100 mL · -8 units · lot L-…`` — built once and
 *  rendered in the "Subject" column. Mirrors the format used by
 *  ``MovementRow`` in the per-entity timeline. */
function subjectLabel(m: ApiMovement): string {
  const item =
    m.item_number && m.item_description
      ? `${m.item_number} · ${m.item_description}`
      : m.item_number ?? m.item_description ?? '—';
  const sign = Number(m.qty_delta) > 0 ? '+' : '−';
  const qty = `${sign}${Number(m.qty_abs).toLocaleString()}`;
  const lot = m.lot_number ? ` · lot ${m.lot_number}` : '';
  // A customer shipment names the customer it left inventory to (CUST-001).
  const shipTo =
    m.movement_type === 'customer_shipment'
      ? ` · → ${m.customer_name ?? 'Catalog'}`
      : '';
  return `${item} · ${qty}${lot}${shipTo}`;
}

/** ``inventory.movement.receipt`` / ``…transfer_out`` / ``…reversal``
 *  for reversal counter-rows so the filter "Action: Reversed" still
 *  groups them. The first segment is hard-coded ``inventory`` to match
 *  the recorder's namespace. */
function eventType(m: ApiMovement): string {
  return `inventory.movement.${m.movement_type}`;
}

/**
 * Build an ``ApiAuditEvent``-shaped object from one movement row. The
 * ``id`` reuses the movement UUID — it can't collide with audit-event
 * UUIDs (different generators, different tables, same namespace).
 */
export function movementToAuditEvent(m: ApiMovement): ApiAuditEvent {
  return {
    id: m.id,
    occurred_at: m.performed_at,
    actor_user_id: m.performed_by_user_id,
    actor_user_email: m.performed_by_user_email,
    actor_user_name: m.performed_by_user_name,
    actor_kind: 'user',
    event_type: eventType(m),
    severity: severityFor(m),
    subject_table: 'app.stock_movements',
    subject_id: m.id,
    subject_label: subjectLabel(m),
    // Movements are always "created" rows in the audit sense — the
    // ledger is append-only, so there are no updates or deletes.
    action: 'created',
    before_state: null,
    // ``after_state`` carries the wire shape verbatim. The detail sheet
    // never reads it (it opens the dedicated movement-detail sheet
    // instead) but JSON exports get the full row this way.
    after_state: m as unknown as Record<string, unknown>,
    diff: null,
    context: {},
    signature_id: m.reauth_evidence_id,
    // The signing rationale rides on the movement as its note; surface it
    // under the same field the audit-event rows use.
    signature_comment: m.notes ?? null,
  };
}

/** Merge two newest-first lists into one newest-first list by
 *  ``occurred_at``. Stable. Lexicographic comparison is fine since
 *  every timestamp is an ISO-8601 string in the same TZ format. */
export function mergeByOccurredAt(
  a: ApiAuditEvent[],
  b: ApiAuditEvent[],
): ApiAuditEvent[] {
  const out: ApiAuditEvent[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]!.occurred_at >= b[j]!.occurred_at) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

/** True when the audit row was synthesised from a stock movement.
 *  The page client uses it to dispatch the row click to the movement
 *  detail sheet instead of the audit-event detail sheet. */
export function isMovementRow(e: ApiAuditEvent): boolean {
  return e.subject_table === 'app.stock_movements';
}
