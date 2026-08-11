'use client';

import * as React from 'react';
import { ChevronRight, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AUDIT_ACTION_LABEL,
  AUDIT_SEVERITY_LABEL,
  AUDIT_SUBJECT_TABLE_LABEL,
  auditApi,
  type ApiAuditAction,
  type ApiAuditEvent,
  type ApiAuditSeverity,
  type ApiAuditSubjectTable,
} from '@/lib/api/audit';
import { humanizeField } from '@/lib/api/audit-phrase';
import { ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Event UUID. The sheet refetches the full row on open so the diff
   *  is current — list rows can be slightly stale across pagination. */
  eventId: string | null;
}

const SEVERITY_STYLE: Record<ApiAuditSeverity, string> = {
  info: 'border-border bg-bg-elev text-text-2',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  danger: 'border-danger/40 bg-danger/10 text-danger',
};

/**
 * Side-sheet detail view for one audit row. Shows the per-field diff,
 * before/after snapshots, the actor + timing, and (when the write was
 * electronically signed) the reason recorded with the signature.
 *
 * Re-fetches on open instead of trusting the list-row payload — saves
 * having to thread state through paginated tables.
 */
export function AuditDetailSheet({ open, onOpenChange, eventId }: Props) {
  const [event, setEvent] = React.useState<ApiAuditEvent | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !eventId) {
      setEvent(null);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    auditApi
      .get(eventId, { signal: ctrl.signal })
      .then(setEvent)
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(
          err instanceof ApiError ? err.message : 'Failed to load audit event.',
        );
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [open, eventId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-2xl">
        <SheetHeader>
          <SheetTitle>Audit event</SheetTitle>
          <SheetDescription>
            Field-level diff, the signer and timestamp, and the reason recorded
            with the electronic signature.
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
        {loading ? (
          <div className="flex items-center gap-2 py-12 text-sm text-text-2">
            <Loader2 size={14} className="animate-spin" /> Loading event…
          </div>
        ) : error ? (
          <p
            role="alert"
            className="my-6 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
          >
            {error}
          </p>
        ) : event ? (
          <div className="space-y-6 text-sm">
            {/* ── What happened, in one line ─────────────────────── */}
            <div className="space-y-1.5">
              <p className="text-base leading-snug text-text-2">
                <span className="font-medium text-text">
                  {event.actor_user_name ?? event.actor_user_email ?? event.actor_kind}
                </span>{' '}
                {AUDIT_ACTION_LABEL[event.action as ApiAuditAction]?.toLowerCase() ??
                  event.action}{' '}
                <span className="font-medium text-text">
                  {event.subject_label ?? '—'}
                </span>
              </p>
              <p className="text-xs text-text-3">
                <span className="font-mono">
                  {new Date(event.occurred_at).toLocaleString()}
                </span>
                {event.actor_user_email && ` · ${event.actor_user_email}`}
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[11px]',
                    event.signature_id
                      ? 'border-success/30 bg-success/5 text-success'
                      : 'border-border bg-surface text-text-3',
                  )}
                >
                  {event.signature_id ? <ShieldCheck size={11} /> : <ShieldAlert size={11} />}
                  {event.signature_id ? 'Signed' : 'Unsigned'}
                </span>
                {/* Severity keeps its badge here — in the sheet there is room
                    for it, and it is the one place the distinction is worth
                    spelling out rather than implying with a row tint. */}
                {event.severity !== 'info' && (
                  <span
                    className={cn(
                      'inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] uppercase tracking-wide',
                      SEVERITY_STYLE[event.severity],
                    )}
                  >
                    {AUDIT_SEVERITY_LABEL[event.severity]}
                  </span>
                )}
                <span className="font-mono text-[11px] text-text-3">
                  {event.event_type}
                </span>
              </div>
            </div>

            {/* ── Why — the signer's own words, given the weight ─── */}
            {event.signature_comment && (
              <blockquote className="border-l-2 border-accent/50 pl-3">
                <p className="whitespace-pre-wrap text-[15px] italic leading-snug text-text-1">
                  “{event.signature_comment}”
                </p>
                <footer className="mt-1 text-[11px] text-text-3">
                  Reason recorded with the electronic signature
                </footer>
              </blockquote>
            )}

            {/* ── What changed — the question every reader has ───── */}
            <DiffSection diff={event.diff} />

            {/* ── Which record ──────────────────────────────────── */}
            <KvGrid>
              <KV
                label="Subject"
                value={
                  AUDIT_SUBJECT_TABLE_LABEL[
                    event.subject_table as ApiAuditSubjectTable
                  ] ?? event.subject_table
                }
              />
              <KV label="Subject label" value={event.subject_label ?? '—'} />
              <KV
                label="Subject ID"
                value={
                  event.subject_id ? (
                    <span className="font-mono text-xs">{event.subject_id}</span>
                  ) : (
                    '—'
                  )
                }
              />
              {event.signature_id && (
                <KV
                  label="Evidence"
                  value={
                    <span className="font-mono text-xs">{event.signature_id}</span>
                  }
                />
              )}
            </KvGrid>

            {/* ── Forensics, folded away ────────────────────────── */}
            {(event.before_state ||
              event.after_state ||
              Object.keys(event.context).length > 0) && (
              <details className="group rounded-md border border-border">
                <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-3 transition-colors hover:text-text-2">
                  <ChevronRight
                    size={12}
                    className="mr-1 inline transition-transform group-open:rotate-90"
                    aria-hidden
                  />
                  Raw snapshots
                </summary>
                <div className="space-y-3 border-t border-border p-3">
                  {(event.before_state || event.after_state) && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <JsonBlock label="Before" data={event.before_state} />
                      <JsonBlock label="After" data={event.after_state} />
                    </div>
                  )}
                  {Object.keys(event.context).length > 0 && (
                    <JsonBlock label="Context" data={event.context} />
                  )}
                </div>
              </details>
            )}
          </div>
        ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function KvGrid({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[100px_1fr] gap-x-4 gap-y-1.5">{children}</dl>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs text-text-3">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </>
  );
}

function DiffSection({
  diff,
}: {
  diff: Record<string, { before: unknown; after: unknown }> | null;
}) {
  if (!diff || Object.keys(diff).length === 0) {
    return (
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-3">
          Changes
        </h3>
        <p className="rounded-md border border-border bg-bg-elev px-3 py-2 text-xs text-text-3">
          No field-level diff for this event (creates and hard deletes
          carry the full snapshot below).
        </p>
      </div>
    );
  }
  const entries = Object.entries(diff);
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-text-3">
        Changes ({entries.length})
      </h3>
      <div className="overflow-hidden rounded-md border border-border">
        {/* ``table-fixed`` + a width on each column: without it the browser
            sizes columns to their content, and one stringified JSON array
            (a kit's ``lines``) stretches the table past the sheet. */}
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-elev text-left text-[11px] uppercase tracking-wider text-text-3">
              <th className="w-[30%] px-3 py-1.5 font-medium">Field</th>
              <th className="w-[35%] px-3 py-1.5 font-medium">Before</th>
              <th className="w-[35%] px-3 py-1.5 font-medium">After</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([field, { before, after }]) => (
              <tr key={field} className="border-b border-border/60 align-top last:border-0">
                <td className="px-3 py-1.5">
                  <div className="break-words">{humanizeField(field)}</div>
                  <div className="break-all font-mono text-[10px] text-text-3">{field}</div>
                </td>
                {/* Struck through, so "what it used to be" reads as past at a
                    glance instead of needing the column header. */}
                <td className="px-3 py-1.5 text-text-3 line-through">{formatJson(before)}</td>
                <td className="px-3 py-1.5 font-medium">{formatJson(after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function JsonBlock({
  label,
  data,
}: {
  label?: string;
  data: unknown;
}) {
  return (
    <div>
      {label && (
        <p className="mb-1 text-xs uppercase tracking-wider text-text-3">
          {label}
        </p>
      )}
      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-bg-elev px-3 py-2 text-[11px] font-mono leading-snug">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

function formatJson(v: unknown): React.ReactNode {
  if (v === null || v === undefined) {
    return <span className="text-text-3">—</span>;
  }
  // ``break-words`` on the scalars and ``break-all`` on the JSON: prose-ish
  // values should break at spaces, but a stringified array has none, so it has
  // to be allowed to break mid-token or it overflows the cell.
  if (typeof v === 'string') return <span className="break-words">{v}</span>;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return (
    <code className="block max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
      {JSON.stringify(v, null, 1)}
    </code>
  );
}
