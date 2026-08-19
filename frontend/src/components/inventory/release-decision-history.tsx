'use client';

import * as React from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';

import { ReleaseStateBadge } from '@/components/inventory/release-state-badge';
import { auditApi, type ApiAuditEvent } from '@/lib/api/audit';
import type { LotReleaseState } from '@/lib/api/lots';

/** One release decision, reduced to the only three things worth reading. */
interface Decision {
  id: string;
  from: LotReleaseState | null;
  to: LotReleaseState;
  at: string;
  by: string;
  signed: boolean;
}

const RELEASE_STATES: readonly string[] = ['quarantine', 'qc_hold', 'released', 'rejected'];

function asState(value: unknown): LotReleaseState | null {
  return typeof value === 'string' && RELEASE_STATES.includes(value)
    ? (value as LotReleaseState)
    : null;
}

/**
 * A batch's release history, as decisions rather than as edits
 * (REQ-2026-07-31-STS-002).
 *
 * The generic audit timeline was already rendered here and it answered the
 * wrong question. "Updated · inventory.lot.updated · 1 field changed" is true,
 * and tells a reviewer nothing about the only thing they came to find out:
 * which state this batch moved FROM and TO, who decided it, and when. So this
 * reads the same audit store and renders the transition itself —
 *
 *     Quarantine → QC Hold      Super Admin · 18 Aug 2026, 07:12
 *
 * Two deliberate reductions:
 *
 *   * **Only release changes appear.** A lot's audit trail also carries expiry
 *     edits and supplier corrections; in a list headed "Decision history" those
 *     are noise, and their presence makes a reviewer count rows that are not
 *     decisions.
 *   * **The state is read from the DIFF, not re-derived.** ``before``/``after``
 *     is what the event actually recorded, so a decision reads the same in a
 *     year even if the workflow's states change around it.
 *
 * There is no history table (STS-002 is satisfied by the audit store), so this
 * is the record — not a convenience view over one.
 */
export function ReleaseDecisionHistory({ lotId }: { lotId: string }) {
  const [rows, setRows] = React.useState<Decision[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setRows(null);
    setFailed(false);
    auditApi
      .list(
        { subjectTable: 'app.lots', subjectId: lotId, limit: 50 },
        { signal: ctrl.signal },
      )
      .then((res) => {
        const decisions: Decision[] = [];
        for (const e of res.items as ApiAuditEvent[]) {
          const change = e.diff?.release_state;
          if (!change) continue;
          const to = asState(change.after);
          if (!to) continue;
          const from = asState(change.before);
          // A no-op write is not a decision.
          if (from === to) continue;
          decisions.push({
            id: e.id,
            from,
            to,
            at: e.occurred_at,
            by: e.actor_user_name ?? e.actor_user_email ?? 'Unknown',
            signed: Boolean(e.signature_id),
          });
        }
        // Oldest first: a release history is read as a sequence, and the state
        // it ended in is the one already shown at the top of the dialog.
        decisions.reverse();
        setRows(decisions);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setFailed(true);
      });
    return () => ctrl.abort();
  }, [lotId]);

  if (failed) {
    return <p className="px-1 py-2 text-xs text-text-3">Could not load the decision history.</p>;
  }
  if (rows === null) {
    return <p className="px-1 py-2 text-xs text-text-3">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="px-1 py-2 text-xs text-text-3">
        No release decisions yet — this batch is still in the state it was made in.
      </p>
    );
  }

  return (
    <ol className="space-y-1.5">
      {rows.map((d) => (
        <li
          key={d.id}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-surface/60 px-2.5 py-2"
        >
          {/* The transition, reading left to right. A batch made under the
              workflow starts at nothing, so the first decision has no "from"
              and simply states where it began. */}
          {d.from ? (
            <>
              <ReleaseStateBadge state={d.from} size="xs" />
              <ArrowRight size={12} className="shrink-0 text-text-3" />
            </>
          ) : (
            <span className="text-[11px] text-text-3">Set to</span>
          )}
          <ReleaseStateBadge state={d.to} size="xs" />

          <span className="ml-auto flex items-center gap-2 text-[11px] text-text-3">
            {d.signed && (
              <span
                className="inline-flex items-center gap-1 text-success"
                title="Recorded with an electronic signature"
              >
                <ShieldCheck size={11} /> e-signed
              </span>
            )}
            <span className="text-text-2">{d.by}</span>
            <span>·</span>
            <time dateTime={d.at}>
              {new Date(d.at).toLocaleString(undefined, {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          </span>
        </li>
      ))}
    </ol>
  );
}
