'use client';

import * as React from 'react';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  AUDIT_ACTION_LABEL,
  AUDIT_SUBJECT_TABLE_LABEL,
  type ApiAuditAction,
  type ApiAuditEvent,
  type ApiAuditSeverity,
  type ApiAuditSubjectTable,
} from '@/lib/api/audit';

interface Props {
  events: ApiAuditEvent[];
  loading: boolean;
  onSelect: (event: ApiAuditEvent) => void;
}

const SEVERITY_DOT: Record<ApiAuditSeverity, string> = {
  info: 'bg-text-3',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

const SEVERITY_LABEL: Record<ApiAuditSeverity, string> = {
  info: 'info',
  warning: 'warn',
  danger: 'critical',
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

export function AuditTable({ events, loading, onSelect }: Props) {
  if (loading && events.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-text-3" role="status">
        Loading audit events…
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-text-3" role="status">
        No events match these filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Actor</th>
            <th className="px-3 py-2 font-medium">Event</th>
            <th className="px-3 py-2 font-medium">Subject</th>
            <th className="px-3 py-2 font-medium">Severity</th>
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr
              key={e.id}
              onClick={() => onSelect(e)}
              className="group cursor-pointer border-b border-border/60 transition-colors hover:bg-surface"
            >
              <td className="px-3 py-2.5 font-mono text-xs text-text-2">
                {formatTime(e.occurred_at)}
              </td>
              <td className="px-3 py-2.5">
                {e.actor_user_name ? (
                  <>
                    <div className="font-medium text-text-1">
                      {e.actor_user_name}
                    </div>
                    <div className="text-[11px] text-text-3">
                      {e.actor_user_email ?? '—'}
                    </div>
                  </>
                ) : (
                  <span className="text-text-3">{e.actor_kind}</span>
                )}
              </td>
              <td className="px-3 py-2.5">
                <div className="font-mono text-xs text-text-2">
                  {e.event_type}
                </div>
                <div className="text-[11px] text-text-3">
                  {AUDIT_ACTION_LABEL[e.action as ApiAuditAction] ?? e.action}
                </div>
              </td>
              <td className="px-3 py-2.5">
                <div className="text-xs text-text-3">
                  {AUDIT_SUBJECT_TABLE_LABEL[
                    e.subject_table as ApiAuditSubjectTable
                  ] ?? e.subject_table}
                </div>
                <div
                  className="truncate font-medium text-text-1"
                  title={e.subject_label ?? undefined}
                >
                  {e.subject_label ?? (
                    <span className="text-text-3">—</span>
                  )}
                </div>
              </td>
              <td className="px-3 py-2.5">
                <span className="inline-flex items-center gap-1.5 text-[11px] capitalize text-text-2">
                  <span
                    className={cn('size-1.5 rounded-full', SEVERITY_DOT[e.severity])}
                    aria-hidden
                  />
                  {SEVERITY_LABEL[e.severity]}
                </span>
              </td>
              <td className="px-3 py-2.5 text-right">
                <ChevronRight
                  size={14}
                  className="text-text-3 transition-transform group-hover:translate-x-0.5"
                  aria-hidden
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
