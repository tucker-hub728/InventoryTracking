'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';

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
import { ApiError } from '@/lib/api/client';
import { signatureImageUrl } from '@/lib/api/uploads';
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
 * before/after snapshots, the actor + timing, and (when the original
 * write was signed) the canvas signature image.
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
            Field-level diff, signed-by, and the e-signature image when the
            originating action was an electronic signature.
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
            {/* ── Header strip ───────────────────────────────────── */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] uppercase tracking-wide',
                    SEVERITY_STYLE[event.severity],
                  )}
                >
                  {AUDIT_SEVERITY_LABEL[event.severity]}
                </span>
                <span className="inline-flex items-center rounded-sm border border-border bg-bg-elev px-2 py-0.5 text-[11px] uppercase tracking-wide text-text-3">
                  {AUDIT_ACTION_LABEL[event.action as ApiAuditAction] ?? event.action}
                </span>
                <span className="font-mono text-xs text-text-3">
                  {event.event_type}
                </span>
              </div>
              <p className="text-xs text-text-3">
                <span className="font-mono">
                  {new Date(event.occurred_at).toLocaleString()}
                </span>{' '}
                · by{' '}
                {event.actor_user_name ? (
                  <>
                    <span className="font-medium text-text-1">
                      {event.actor_user_name}
                    </span>{' '}
                    <span className="text-text-3">
                      ({event.actor_user_email ?? '—'})
                    </span>
                  </>
                ) : (
                  <span className="text-text-2">{event.actor_kind}</span>
                )}
              </p>
            </div>

            {/* ── Subject ───────────────────────────────────────── */}
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

            {/* ── Diff ──────────────────────────────────────────── */}
            <DiffSection diff={event.diff} />

            {/* ── Before / After raw JSON for forensics ─────────── */}
            {(event.before_state || event.after_state) && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-3">
                  Snapshots
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <JsonBlock label="Before" data={event.before_state} />
                  <JsonBlock label="After" data={event.after_state} />
                </div>
              </div>
            )}

            {/* ── Signature image (if signed) ───────────────────── */}
            {event.signature_id && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-3">
                  Hand-drawn signature
                </h3>
                {/* Mid-gray inner surface contrasts with both dark-mode
                    (white) and light-mode (near-black) ink strokes. */}
                <div className="rounded-md border border-border bg-bg-elev p-3">
                  <div className="rounded-sm bg-[#9ca3af] p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={signatureImageUrl(event.signature_id)}
                      alt="Hand-drawn e-signature"
                      className="mx-auto block max-h-48"
                      onError={(e) => {
                        // No image stored (headless reauth, or v2 audit
                        // without a signature). Replace with a placeholder.
                        e.currentTarget.replaceWith(
                          Object.assign(document.createElement('p'), {
                            className: 'text-xs text-text-3 text-center py-6',
                            textContent: 'No signature image on file.',
                          }),
                        );
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* ── Request context ───────────────────────────────── */}
            {Object.keys(event.context).length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-3">
                  Context
                </h3>
                <JsonBlock data={event.context} />
              </div>
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
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-elev text-left text-[11px] uppercase tracking-wider text-text-3">
              <th className="px-3 py-1.5 font-medium">Field</th>
              <th className="px-3 py-1.5 font-medium">Before</th>
              <th className="px-3 py-1.5 font-medium">After</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([field, { before, after }]) => (
              <tr key={field} className="border-b border-border/60 last:border-0">
                <td className="px-3 py-1.5 font-mono text-xs">{field}</td>
                <td className="px-3 py-1.5 text-text-3">{formatJson(before)}</td>
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
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return <code className="font-mono text-[11px]">{JSON.stringify(v)}</code>;
}
