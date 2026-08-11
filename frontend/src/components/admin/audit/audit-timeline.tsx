'use client';

import * as React from 'react';
import { ChevronRight, ShieldCheck, ShieldAlert } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { auditPhrase, changeSummary } from '@/lib/api/audit-phrase';
import type { ApiTimelineEvent } from '@/lib/api/audit';

interface Props {
  events: ApiTimelineEvent[];
  loading: boolean;
  onSelect: (event: ApiTimelineEvent) => void;
  /** Row the keyboard cursor is on, so it can be highlighted + scrolled to. */
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
}

/** How many field changes to spell out before collapsing to a count. */
const MAX_INLINE_CHANGES = 3;

const DAY = 86_400_000;

/** ``Today`` / ``Yesterday`` / ``Sat 9 Aug 2026`` for a day separator. */
function dayHeading(iso: string): string {
  const d = new Date(iso);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const delta = Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

/** Local day key, so events either side of midnight don't share a group. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** ``just now`` / ``12m`` / ``3h`` / ``6d``. Kept terse — it sits under the clock. */
function relativeTime(iso: string): string {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  const days = Math.floor(secs / 86_400);
  if (days < 30) return `${days}d ago`;
  return '';
}

/** Two-letter initials for the actor dot. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : (parts[0][1] ?? '');
  return (first + last).toUpperCase();
}

/**
 * The audit log as a timeline, not a table.
 *
 * A six-column grid forced every row to the width of its widest cell and made
 * the reader assemble ``inventory.supplier.updated`` + ``Jordan Rogers`` into a
 * meaning. This renders one sentence per row — who did what to which record —
 * with the changed fields underneath and the machine-readable event type
 * demoted to a caption for whoever still wants it.
 *
 * Colour is spent where it is scarce: severity had four rows out of four
 * reading ``info``, so it no longer takes a column. What an auditor scans for
 * is whether a write was signed, and that gets the badge instead.
 */
export function AuditTimeline({
  events,
  loading,
  onSelect,
  activeId,
  onActiveChange,
}: Props) {
  if (loading) return <TimelineSkeleton />;

  if (events.length === 0) {
    return (
      <div className="py-16 text-center text-sm text-text-3" role="status">
        No events match these filters.
      </div>
    );
  }

  let lastDay = '';

  return (
    <ul className="relative" aria-label="Audit events">
      {events.map((e) => {
        const key = dayKey(e.occurred_at);
        const newDay = key !== lastDay;
        lastDay = key;
        return (
          <React.Fragment key={e.id}>
            {newDay && (
              <li
                className="sticky top-0 z-10 -mx-4 border-y border-border bg-bg-elev px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-text-3 backdrop-blur"
                aria-hidden
              >
                {dayHeading(e.occurred_at)}
              </li>
            )}
            <TimelineRow
              event={e}
              active={e.id === activeId}
              onSelect={onSelect}
              onFocus={() => onActiveChange(e.id)}
            />
          </React.Fragment>
        );
      })}
    </ul>
  );
}

function TimelineRow({
  event,
  active,
  onSelect,
  onFocus,
}: {
  event: ApiTimelineEvent;
  active: boolean;
  onSelect: (e: ApiTimelineEvent) => void;
  onFocus: () => void;
}) {
  const phrase = auditPhrase(event);
  const changes = changeSummary(event);
  const ref = React.useRef<HTMLLIElement>(null);

  // Keep the keyboard cursor on screen when j/k walks past the fold.
  React.useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const rel = relativeTime(event.occurred_at);

  return (
    <li
      ref={ref}
      data-audit-row={event.id}
      className={cn(
        'group relative flex cursor-pointer gap-3 border-b border-border/60 px-1 py-3 transition-colors hover:bg-surface sm:gap-4',
        active && 'bg-surface',
        // Only the genuinely rare severities earn colour; ``info`` — which is
        // nearly every row — stays neutral so the exceptions stand out.
        event.severity === 'warning' && 'border-l-2 border-l-warning pl-2',
        event.severity === 'danger' && 'border-l-2 border-l-danger bg-danger/5 pl-2',
      )}
      onClick={() => onSelect(event)}
      onMouseEnter={onFocus}
    >
      {/* ── Time rail ─────────────────────────────────────────────── */}
      <div className="w-14 shrink-0 pt-0.5 text-right sm:w-16">
        <div
          className="font-mono text-xs text-text-2"
          title={new Date(event.occurred_at).toLocaleString()}
        >
          {clockTime(event.occurred_at)}
        </div>
        {rel && <div className="text-[10px] text-text-3">{rel}</div>}
      </div>

      {/* ── Actor dot ─────────────────────────────────────────────── */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-[10px] font-medium text-text-2 ring-1 ring-border">
            {initialsOf(phrase.actor)}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {phrase.actor}
          {event.actor_user_email && ` · ${event.actor_user_email}`}
        </TooltipContent>
      </Tooltip>

      {/* ── Sentence ──────────────────────────────────────────────── */}
      {/* ``min-w-0`` lets this column shrink below its content's intrinsic
          width, and ``overflow-hidden`` is the backstop: audit values are
          arbitrary stored data, so no single child's truncation rule can be
          trusted to be the last word. */}
      <div className="min-w-0 flex-1 overflow-hidden">
        <p className="break-words text-sm leading-snug text-text-2">
          <span className="font-medium text-text">{phrase.actor}</span>{' '}
          {phrase.verb}{' '}
          {phrase.noun && <span>{phrase.noun} </span>}
          {phrase.from && (
            <>
              <span className="text-text-3 line-through">{phrase.from}</span>
              <span className="mx-1 text-text-3" aria-label="renamed to">
                →
              </span>
            </>
          )}
          <span className="font-medium text-text">{phrase.object}</span>
        </p>

        {changes.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-3">
            {changes.slice(0, MAX_INLINE_CHANGES).map((c) =>
              c.complex ? (
                // Structured or over-long values (a kit's ``lines`` array) get
                // named, not printed: stringified JSON is one unbreakable
                // token, so inlining it forces the row wider than the page.
                <span key={c.field} className="max-w-full truncate">
                  <span className="text-text-2">{c.field}</span> changed
                </span>
              ) : (
                <span
                  key={c.field}
                  className="inline-flex max-w-full items-center gap-1 overflow-hidden"
                >
                  <span className="shrink-0 text-text-3">{c.field}:</span>
                  <span className="min-w-0 truncate line-through opacity-70">{c.before}</span>
                  <span className="shrink-0" aria-hidden>
                    →
                  </span>
                  <span className="min-w-0 truncate text-text-2">{c.after}</span>
                </span>
              ),
            )}
            {changes.length > MAX_INLINE_CHANGES && (
              <span className="shrink-0">
                and {changes.length - MAX_INLINE_CHANGES} more
              </span>
            )}
          </div>
        )}

        {event.reason && (
          <p className="mt-1 truncate border-l-2 border-border pl-2 text-[11px] italic text-text-3">
            “{event.reason}”
          </p>
        )}

        <p className="mt-1 truncate font-mono text-[10px] text-text-3/70">
          {event.event_type}
        </p>
      </div>

      {/* ── Signature + affordance ────────────────────────────────── */}
      <div className="flex shrink-0 items-start gap-2 pt-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px]',
                event.signed
                  ? 'border-success/30 bg-success/5 text-success'
                  : 'border-border bg-surface text-text-3',
              )}
            >
              {event.signed ? <ShieldCheck size={11} /> : <ShieldAlert size={11} />}
              <span className="hidden sm:inline">
                {event.signed ? 'Signed' : 'Unsigned'}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {event.signed
              ? 'Authorised by an electronic signature'
              : 'No electronic signature was recorded for this write'}
          </TooltipContent>
        </Tooltip>
        <ChevronRight
          size={14}
          className="mt-0.5 text-text-3 transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </div>
    </li>
  );
}

/** Loading placeholder at the timeline's own rhythm, not a table's. */
function TimelineSkeleton() {
  return (
    <div>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex gap-4 border-b border-border/60 px-1 py-3">
          <div className="w-14 shrink-0 space-y-1 sm:w-16">
            <Skeleton className="ml-auto h-3 w-10" />
            <Skeleton className="ml-auto h-2 w-8" />
          </div>
          <Skeleton className="mt-0.5 size-6 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-2.5 w-1/3" />
            <Skeleton className="h-2 w-24" />
          </div>
          <Skeleton className="h-4 w-16 shrink-0" />
        </div>
      ))}
      <span className="sr-only" role="status">
        Loading audit events…
      </span>
    </div>
  );
}
