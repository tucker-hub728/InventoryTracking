/**
 * Audit viewer API — wraps ``/api/v1/audit``.
 *
 * Read-only client surface. Writes happen server-side via the
 * recorder helper (every PATCH/DELETE/movement endpoint records its
 * own row inside the same transaction).
 */

import { api } from './client';

export type ApiAuditSeverity = 'info' | 'warning' | 'danger';
export type ApiAuditActorKind = 'user' | 'system' | 'integration';
export type ApiAuditAction = 'created' | 'updated' | 'deleted' | 'restored';

/** Whitelisted subject_table values — keep aligned with the backend. */
export type ApiAuditSubjectTable =
  | 'meta.suppliers'
  | 'meta.locations'
  | 'app.items'
  | 'app.lots'
  | 'app.users'
  | 'app.stock_movements';

/** Human-readable labels for the subject_table dropdown. */
export const AUDIT_SUBJECT_TABLE_LABEL: Record<ApiAuditSubjectTable, string> = {
  'meta.suppliers': 'Suppliers',
  'meta.locations': 'Locations',
  'app.items': 'Items',
  'app.lots': 'Lots',
  'app.users': 'Users',
  'app.stock_movements': 'Movements',
};

export const AUDIT_SEVERITY_LABEL: Record<ApiAuditSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  danger: 'Critical',
};

export const AUDIT_ACTION_LABEL: Record<ApiAuditAction, string> = {
  created: 'Created',
  updated: 'Updated',
  deleted: 'Deleted',
  restored: 'Restored',
};

/**
 * One audit timeline entry. ``before_state`` / ``after_state`` / ``diff``
 * are deliberately ``unknown`` — the row-level shape depends on which
 * entity wrote it, and rendering walks the keys generically.
 */
export interface ApiAuditEvent {
  id: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_user_email: string | null;
  actor_user_name: string | null;
  actor_kind: ApiAuditActorKind;
  event_type: string;
  severity: ApiAuditSeverity;
  subject_table: string;
  subject_id: string | null;
  subject_label: string | null;
  action: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  diff: Record<string, { before: unknown; after: unknown }> | null;
  context: Record<string, unknown>;
  signature_id: string | null;
  /** The operator's mandatory rationale captured at signing time, joined
   *  from the e-signature record. Null for unsigned events. */
  signature_comment: string | null;
}

export interface ApiAuditEventListResponse {
  items: ApiAuditEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListAuditEventsParams {
  /** Scope to events about the LOTS of this item. Release decisions are recorded
   *  against the lot, so an item's own history needs this to see them — pair it
   *  with `subjectTable: 'app.lots'`. */
  lotsOfItem?: string;
  subjectTable?: ApiAuditSubjectTable;
  subjectId?: string;
  actorUserId?: string;
  eventType?: string;
  severity?: ApiAuditSeverity;
  action?: ApiAuditAction;
  /** true = signed writes only, false = unsigned only. */
  signed?: boolean;
  /** ISO timestamp — inclusive lower bound. */
  occurredFrom?: string;
  /** ISO timestamp — exclusive upper bound. */
  occurredTo?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

/** Which physical table a timeline row came from — decides which detail sheet
 *  a row click opens. Sent by the server rather than inferred from
 *  ``subject_table``: an audit event *about* a movement looks identical. */
export type ApiTimelineSource = 'audit' | 'movement';

/**
 * One row of the unified timeline. Summary fields only — the diff, the
 * signature details and the full ledger entry are fetched by id when the row
 * is opened, so paging doesn't drag a JSONB blob per row across the wire.
 */
export interface ApiTimelineEvent {
  id: string;
  source: ApiTimelineSource;
  occurred_at: string;
  actor_user_id: string | null;
  actor_user_email: string | null;
  actor_user_name: string | null;
  actor_kind: ApiAuditActorKind;
  event_type: string;
  severity: ApiAuditSeverity;
  subject_table: string;
  subject_id: string | null;
  subject_label: string | null;
  action: string;
  /** Whether the write carried an electronic signature. */
  signed: boolean;
  /** Per-field before/after for what changed. Null on a ledger row. */
  diff: Record<string, { before: unknown; after: unknown }> | null;
  /** The operator's own words — signature rationale, or a movement's note. */
  reason: string | null;
  /** What the subject was called before this event renamed it. */
  previous_label: string | null;
}

/** Counts over the whole filtered set, for the triage strip. */
export interface ApiTimelineFacets {
  deletions: number;
  role_changes: number;
  unsigned: number;
}

export interface ApiTimelineListResponse {
  items: ApiTimelineEvent[];
  total: number;
  limit: number;
  offset: number;
  facets: ApiTimelineFacets;
}

export const auditApi = {
  /**
   * The audit viewer's list: audit events AND stock movements, merged,
   * filtered and paginated by the database. Replaces the old client-side
   * merge of two over-fetched windows, which could not produce an honest
   * page 5 or an honest total.
   */
  timeline: (params: ListAuditEventsParams = {}, opts?: { signal?: AbortSignal }) =>
    api.get<ApiTimelineListResponse>('/audit/timeline', {
      query: {
        subject_table: params.subjectTable,
        subject_id: params.subjectId,
        actor_user_id: params.actorUserId,
        severity: params.severity,
        action: params.action,
        signed: params.signed,
        occurred_from: params.occurredFrom,
        occurred_to: params.occurredTo,
        q: params.q,
        limit: params.limit,
        offset: params.offset,
      },
      signal: opts?.signal,
    }),

  list: (params: ListAuditEventsParams = {}, opts?: { signal?: AbortSignal }) =>
    api.get<ApiAuditEventListResponse>('/audit/events', {
      query: {
        subject_table: params.subjectTable,
        subject_id: params.subjectId,
        lots_of_item: params.lotsOfItem,
        actor_user_id: params.actorUserId,
        event_type: params.eventType,
        severity: params.severity,
        action: params.action,
        occurred_from: params.occurredFrom,
        occurred_to: params.occurredTo,
        q: params.q,
        limit: params.limit,
        offset: params.offset,
      },
      signal: opts?.signal,
    }),

  get: (eventId: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiAuditEvent>(`/audit/events/${eventId}`, { signal: opts?.signal }),
};
