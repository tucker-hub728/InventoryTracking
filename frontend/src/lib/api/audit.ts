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
  subjectTable?: ApiAuditSubjectTable;
  subjectId?: string;
  actorUserId?: string;
  eventType?: string;
  severity?: ApiAuditSeverity;
  action?: ApiAuditAction;
  /** ISO timestamp — inclusive lower bound. */
  occurredFrom?: string;
  /** ISO timestamp — exclusive upper bound. */
  occurredTo?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export const auditApi = {
  list: (params: ListAuditEventsParams = {}, opts?: { signal?: AbortSignal }) =>
    api.get<ApiAuditEventListResponse>('/audit/events', {
      query: {
        subject_table: params.subjectTable,
        subject_id: params.subjectId,
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
