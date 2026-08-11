/**
 * Turn an audit timeline row into a sentence a person can read.
 *
 * The old viewer showed ``inventory.supplier.updated`` in one column and
 * ``Jordan Rogers`` in another and left the reader to assemble the meaning.
 * Every part of "Super Admin renamed supplier ATCC → Jordan Rogers" is already
 * in the row — actor, action, subject table, label, and the stored diff — so
 * this is a formatting problem, not a data one.
 *
 * Nothing here invents facts. Where the row doesn't support a specific verb it
 * falls back to the generic one rather than guessing.
 */

import {
  MOVEMENT_TYPE_LABEL,
  type MovementType,
} from './movements';
import type { ApiTimelineEvent } from './audit';

/** Singular noun for a subject table, used as "…the supplier ATCC". */
const SUBJECT_NOUN: Record<string, string> = {
  'meta.suppliers': 'supplier',
  'meta.locations': 'location',
  'app.items': 'item',
  'app.lots': 'lot',
  'app.users': 'member',
  'app.stock_movements': 'stock',
  'meta.location_nodes': 'location',
  'app.customers': 'customer',
  'app.kits': 'kit',
  'app.kit_lines': 'kit line',
  'app.item_tiers': 'tier',
  'app.item_prefixes': 'prefix',
  'app.bom_lines': 'BOM line',
  'app.consumable_issues': 'consumable issue',
  // Receiving writes under its own table names; "created receipt_events" is
  // not a phrase anybody says out loud.
  'app.receipt_transactions': 'order',
  'app.receipt_transaction_lines': 'order line',
  'app.receipt_events': 'receipt',
  'app.receipt_event_lines': 'receipt line',
  'meta.item_suppliers': 'supplier link',
};

/** Past-tense verb per action. Deliberately plain English. */
const ACTION_VERB: Record<string, string> = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  restored: 'restored',
};

/**
 * Past-tense verb per movement type.
 *
 * Deliberately not ``MOVEMENT_TYPE_LABEL``: those are column headings — "Unit
 * in", "Adjustment" — and "Super Admin unit in CR-001" is not a sentence. The
 * ledger's own labels stay as they are; this is the narrative form.
 */
const MOVEMENT_VERB: Partial<Record<MovementType, string>> = {
  receipt: 'received',
  dispense: 'dispensed',
  adjustment: 'adjusted',
  discard: 'discarded',
  transfer_out: 'transferred out',
  transfer_in: 'transferred in',
  kit_issue: 'issued',
  kit_additional_issue: 'issued more',
  production_output: 'produced',
  backflush: 'back-flushed',
  kit_return: 'returned',
  kit_cancel_return: 'returned from a cancelled kit',
  customer_shipment: 'shipped',
  consumable_issue: 'issued',
};

/**
 * Verbs for the shapes that deserve better than "updated".
 *
 * Keyed by the set of fields that changed — a diff touching only
 * ``is_active`` is a deactivation, not an edit, and saying so is the
 * difference between a log and a sentence.
 */
function specificVerb(
  event: ApiTimelineEvent,
): { verb: string; skipChangeSummary?: boolean } | null {
  const diff = event.diff;
  if (!diff) return null;
  const fields = Object.keys(diff);
  if (fields.length === 0) return null;

  const activeChange = diff.is_active;
  if (fields.length === 1 && activeChange) {
    // ``after`` arrives as a real boolean from JSONB, but the users recorder
    // stringifies it — accept both rather than mis-labelling one of them.
    const after = activeChange.after;
    const turnedOn = after === true || after === 'True' || after === 'true';
    return { verb: turnedOn ? 'reactivated' : 'deactivated', skipChangeSummary: true };
  }
  if (fields.length === 1 && diff.role) {
    return { verb: 'changed the role of' };
  }
  const nameField = fields.find((f) => f === 'name' || f === 'full_name');
  if (nameField && event.previous_label) {
    return { verb: 'renamed' };
  }
  return null;
}

/**
 * Noun for a subject table. A table this doesn't know about still has to read
 * as English, so the fallback de-snakes it and drops the plural rather than
 * printing ``receipt_events`` into the middle of a sentence.
 */
function nounFor(subjectTable: string): string {
  const known = SUBJECT_NOUN[subjectTable];
  if (known) return known;
  const table = subjectTable.split('.').pop() ?? 'record';
  const words = table.replace(/_/g, ' ');
  return words.endsWith('s') ? words.slice(0, -1) : words;
}

export interface AuditPhrase {
  /** Who acted. "System" when there is no user behind it. */
  actor: string;
  /** Past-tense verb, e.g. "renamed", "deactivated", "shipped". */
  verb: string;
  /** Noun for the thing acted on, e.g. "supplier". Empty when the object
   *  already names itself (a movement's subject label is self-describing). */
  noun: string;
  /** The thing acted on, as it should be shown. */
  object: string;
  /** Prior name, when this event was a rename — rendered "ATCC → Jordan". */
  from: string | null;
}

/**
 * The row's sentence, as parts so the renderer can weight them
 * (actor and object bold, verb plain).
 */
export function auditPhrase(event: ApiTimelineEvent): AuditPhrase {
  const actor =
    event.actor_user_name ??
    event.actor_user_email ??
    (event.actor_kind === 'user' ? 'Unknown user' : 'System');

  // A ledger row already reads as an event; its type IS the verb.
  if (event.source === 'movement') {
    const type = event.event_type.replace('inventory.movement.', '') as MovementType;
    return {
      actor,
      verb:
        MOVEMENT_VERB[type] ??
        (MOVEMENT_TYPE_LABEL[type] ?? type.replace(/_/g, ' ')).toLowerCase(),
      noun: '',
      object: event.subject_label ?? '—',
      from: null,
    };
  }

  const specific = specificVerb(event);
  const verb = specific?.verb ?? ACTION_VERB[event.action] ?? event.action;

  return {
    actor,
    verb,
    noun: nounFor(event.subject_table),
    object: event.subject_label ?? '—',
    from: specific?.verb === 'renamed' ? event.previous_label : null,
  };
}

export interface FieldChange {
  field: string;
  before: string;
  after: string;
  /**
   * The value is structured (a kit's ``lines`` array) or simply too long to
   * put in a list row. The renderer shows "Lines changed" and leaves the
   * values to the detail sheet — a before/after of two JSON arrays is not
   * something anybody reads at a glance, and stringified JSON is one
   * unbreakable token that blows the row's width out.
   */
  complex: boolean;
}

/** ``contact_email`` → ``Contact email``. */
export function humanizeField(field: string): string {
  const spaced = field.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Longest value worth inlining in a list row. Beyond this the field name
 *  alone carries more information than a truncated blob. */
const MAX_INLINE_VALUE = 32;

/** Render a JSON diff value as something short enough for one line. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  // The users recorder stringifies booleans; show them the same way.
  if (value === 'True' || value === 'true') return 'Yes';
  if (value === 'False' || value === 'false') return 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** True when a value can't be shown inline without wrecking the row. */
function isComplex(value: unknown): boolean {
  if (value !== null && typeof value === 'object') return true;
  return formatValue(value).length > MAX_INLINE_VALUE;
}

/**
 * The changed fields, for the sub-line under the sentence.
 *
 * Suppressed when the verb already said it: "deactivated" makes
 * ``is_active: Yes → No`` pure noise, and a rename is already spelled out in
 * the sentence itself.
 */
export function changeSummary(event: ApiTimelineEvent): FieldChange[] {
  if (!event.diff) return [];
  // A create diffs against nothing, so every initial value shows up as a
  // "change" — thirteen of them on a lot. "created lot L-0921" already says
  // it; the opening values belong in the detail sheet, not the list.
  if (event.action === 'created') return [];
  const specific = specificVerb(event);
  if (specific?.skipChangeSummary) return [];

  return Object.entries(event.diff)
    .filter(([field]) => !(specific?.verb === 'renamed' && (field === 'name' || field === 'full_name')))
    .map(([field, change]) => ({
      field: humanizeField(field),
      before: formatValue(change?.before),
      after: formatValue(change?.after),
      complex: isComplex(change?.before) || isComplex(change?.after),
    }))
    // Scalars first: "Status: draft → in_production" is the useful part, and a
    // bare "Lines changed" shouldn't push it past the inline limit.
    .sort((a, b) => Number(a.complex) - Number(b.complex));
}
