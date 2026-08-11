'use client';

import * as React from 'react';
import {
  Filter,
  Search,
  ShieldAlert,
  Trash2,
  UserCog,
  X,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  AUDIT_ACTION_LABEL,
  AUDIT_SEVERITY_LABEL,
  AUDIT_SUBJECT_TABLE_LABEL,
  type ApiAuditAction,
  type ApiAuditSeverity,
  type ApiAuditSubjectTable,
  type ApiTimelineFacets,
} from '@/lib/api/audit';

export interface AuditFilters {
  q: string;
  subjectTable: ApiAuditSubjectTable | 'all';
  severity: ApiAuditSeverity | 'all';
  action: ApiAuditAction | 'all';
  signed: 'all' | 'signed' | 'unsigned';
  /** ISO date (YYYY-MM-DD). Empty = no filter. */
  from: string;
  /** ISO date (YYYY-MM-DD). Empty = no filter. */
  to: string;
}

export const EMPTY_FILTERS: AuditFilters = {
  q: '',
  subjectTable: 'all',
  severity: 'all',
  action: 'all',
  signed: 'all',
  from: '',
  to: '',
};

/** ``YYYY-MM-DD`` in the viewer's own timezone. ``toISOString`` would shift
 *  the date across midnight for anyone west of UTC. */
function isoLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayLocal(): string {
  return isoLocal(new Date());
}

/** ``n`` days before today, as a local ISO date. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoLocal(d);
}

/**
 * Date shortcuts. Typing two dates to answer "what happened this week" is
 * the kind of friction that stops people filtering at all.
 *
 * Ranges are inclusive on both ends — the backend turns ``to`` into the start
 * of the following day — so "Last 7 days" is today plus the six before it.
 */
const TODAY_RANGE = () => ({ from: todayLocal(), to: todayLocal() });

const DATE_PRESETS: ReadonlyArray<{ label: string; range: () => { from: string; to: string } }> = [
  { label: 'Today', range: TODAY_RANGE },
  { label: '7 days', range: () => ({ from: daysAgo(6), to: todayLocal() }) },
  { label: '30 days', range: () => ({ from: daysAgo(29), to: todayLocal() }) },
  {
    label: 'This month',
    range: () => {
      const d = new Date();
      return { from: isoLocal(new Date(d.getFullYear(), d.getMonth(), 1)), to: todayLocal() };
    },
  },
];

/**
 * One-click views for the questions people actually open this page to ask.
 * Cheap to offer now that every filter lives in the URL — each is just a
 * pre-baked query string.
 */
const SAVED_VIEWS: ReadonlyArray<{
  id: string;
  label: string;
  icon: LucideIcon;
  patch: Partial<AuditFilters>;
}> = [
  { id: 'deletions', label: 'Deletions', icon: Trash2, patch: { action: 'deleted' } },
  {
    id: 'roles',
    label: 'Role & access',
    icon: UserCog,
    patch: { subjectTable: 'app.users' },
  },
  {
    id: 'unsigned',
    label: 'Unsigned',
    icon: ShieldAlert,
    patch: { signed: 'unsigned' },
  },
];

interface Props {
  value: AuditFilters;
  /** Everything except the search box — those changes commit immediately. */
  onChange: (patch: Partial<AuditFilters>) => void;
  /** Search-box draft, kept local so typing doesn't wait on the router. */
  queryDraft: string;
  onQueryDraftChange: (next: string) => void;
  onClear: () => void;
  /** Counts across the whole filtered set, for the triage strip. */
  facets: ApiTimelineFacets | null;
  /** Total matching rows, shown beside the triage counts. */
  total: number;
  /** Focused by the ``/`` shortcut. */
  searchRef?: React.RefObject<HTMLInputElement>;
}

/** An applied filter, rendered as a removable pill. */
interface Chip {
  key: keyof AuditFilters;
  label: string;
  reset: Partial<AuditFilters>;
}

function activeChips(v: AuditFilters): Chip[] {
  const chips: Chip[] = [];
  if (v.subjectTable !== 'all') {
    chips.push({
      key: 'subjectTable',
      label: `Subject: ${AUDIT_SUBJECT_TABLE_LABEL[v.subjectTable] ?? v.subjectTable}`,
      reset: { subjectTable: 'all' },
    });
  }
  if (v.action !== 'all') {
    chips.push({
      key: 'action',
      label: AUDIT_ACTION_LABEL[v.action] ?? v.action,
      reset: { action: 'all' },
    });
  }
  if (v.severity !== 'all') {
    chips.push({
      key: 'severity',
      label: `Severity: ${AUDIT_SEVERITY_LABEL[v.severity] ?? v.severity}`,
      reset: { severity: 'all' },
    });
  }
  if (v.signed !== 'all') {
    chips.push({
      key: 'signed',
      label: v.signed === 'signed' ? 'Signed only' : 'Unsigned only',
      reset: { signed: 'all' },
    });
  }
  if (v.from) chips.push({ key: 'from', label: `From ${v.from}`, reset: { from: '' } });
  if (v.to) chips.push({ key: 'to', label: `To ${v.to}`, reset: { to: '' } });
  return chips;
}

/**
 * Filter bar for the audit viewer.
 *
 * Six permanent dropdowns used to own a whole band of the screen whether or not
 * anything was filtered. Here the controls live behind "Filter" and only what
 * is actually *applied* takes space — as removable chips, so the current
 * question is always legible in one line.
 *
 * Above them sits the triage strip: how many deletions, role changes and
 * unsigned writes are in the current result. Each is a link that narrows to
 * them, which turns the page from something you read into something you steer.
 */
export function AuditFiltersBar({
  value,
  onChange,
  queryDraft,
  onQueryDraftChange,
  onClear,
  facets,
  total,
  searchRef,
}: Props) {
  const chips = activeChips(value);
  const isDirty = chips.length > 0 || value.q !== '' || queryDraft !== '';
  const today = TODAY_RANGE();
  const todayActive = value.from === today.from && value.to === today.to;

  const triage = facets
    ? [
        {
          id: 'deletions',
          n: facets.deletions,
          label: facets.deletions === 1 ? 'deletion' : 'deletions',
          patch: { action: 'deleted' } as Partial<AuditFilters>,
          tone: 'text-warning',
        },
        {
          id: 'roles',
          n: facets.role_changes,
          label: facets.role_changes === 1 ? 'role change' : 'role changes',
          patch: { subjectTable: 'app.users' } as Partial<AuditFilters>,
          tone: 'text-warning',
        },
        {
          id: 'unsigned',
          n: facets.unsigned,
          label: 'unsigned',
          patch: { signed: 'unsigned' } as Partial<AuditFilters>,
          tone: 'text-text-2',
        },
      ].filter((t) => t.n > 0)
    : [];

  return (
    <div className="space-y-3">
      {/* ── Search · Filter · saved views ─────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3"
            aria-hidden
          />
          <Input
            ref={searchRef}
            id="audit-q"
            value={queryDraft}
            onChange={(e) => onQueryDraftChange(e.target.value)}
            placeholder="Search events, records, lots…    /"
            className="pl-9"
            aria-label="Search the audit log"
          />
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="default" className="shrink-0">
              <Filter size={14} />
              <span className="ml-1.5">Filter</span>
              {chips.length > 0 && (
                <span className="ml-1.5 rounded-full bg-text px-1.5 text-[10px] text-bg">
                  {chips.length}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[380px] max-w-[calc(100vw-2rem)]" align="end">
            <header className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
              <h2 className="text-xs font-semibold text-text">Filter events</h2>
              {chips.length > 0 && (
                <span className="text-[11px] tabular-nums text-text-3">
                  {chips.length} active
                </span>
              )}
            </header>

            <div className="space-y-3.5 px-3.5 py-3">
              {/* Two segmented rows first: both are short, closed sets, and a
                  pill row answers them in one click where a select needs two
                  and hides the options until you open it. */}
              <Field label="Signature">
                <SegmentedControl
                  aria-label="Filter by signature"
                  className="w-full [&>button]:flex-1"
                  value={value.signed}
                  onChange={(v) => onChange({ signed: v as AuditFilters['signed'] })}
                  options={[
                    { value: 'all', label: 'Any' },
                    { value: 'signed', label: 'Signed' },
                    { value: 'unsigned', label: 'Unsigned' },
                  ]}
                />
              </Field>

              <Field label="Severity">
                <SegmentedControl
                  aria-label="Filter by severity"
                  className="w-full [&>button]:flex-1 [&>button]:px-1.5"
                  value={value.severity}
                  onChange={(v) => onChange({ severity: v as AuditFilters['severity'] })}
                  options={[
                    { value: 'all', label: 'Any' },
                    ...(Object.keys(AUDIT_SEVERITY_LABEL) as ApiAuditSeverity[]).map(
                      (s) => ({ value: s, label: AUDIT_SEVERITY_LABEL[s] }),
                    ),
                  ]}
                />
              </Field>

              {/* These two have too many options for pills, and pair naturally:
                  "which kind of record" and "what was done to it". */}
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="Subject" htmlFor="audit-subject">
                  <Select
                    value={value.subjectTable}
                    onValueChange={(v) =>
                      onChange({ subjectTable: v as AuditFilters['subjectTable'] })
                    }
                  >
                    <SelectTrigger id="audit-subject" className="[&>span]:truncate">
                      <SelectValue placeholder="All" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All subjects</SelectItem>
                      {(
                        Object.keys(AUDIT_SUBJECT_TABLE_LABEL) as ApiAuditSubjectTable[]
                      ).map((t) => (
                        <SelectItem key={t} value={t}>
                          {AUDIT_SUBJECT_TABLE_LABEL[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Action" htmlFor="audit-action">
                  <Select
                    value={value.action}
                    onValueChange={(v) => onChange({ action: v as AuditFilters['action'] })}
                  >
                    <SelectTrigger id="audit-action" className="[&>span]:truncate">
                      <SelectValue placeholder="All" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All actions</SelectItem>
                      {(Object.keys(AUDIT_ACTION_LABEL) as ApiAuditAction[]).map((a) => (
                        <SelectItem key={a} value={a}>
                          {AUDIT_ACTION_LABEL[a]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <Field label="Date range">
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {DATE_PRESETS.map((preset) => {
                    const r = preset.range();
                    const on = value.from === r.from && value.to === r.to;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => onChange(on ? { from: '', to: '' } : r)}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                          on
                            ? 'border-text bg-text text-bg'
                            : 'border-border-strong bg-bg-elev text-text-2 hover:bg-surface',
                        )}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    id="audit-from"
                    type="date"
                    aria-label="From date"
                    value={value.from}
                    onChange={(e) => onChange({ from: e.target.value })}
                  />
                  <span className="text-text-3" aria-hidden>
                    →
                  </span>
                  <Input
                    id="audit-to"
                    type="date"
                    aria-label="To date"
                    value={value.to}
                    onChange={(e) => onChange({ to: e.target.value })}
                  />
                </div>
              </Field>
            </div>

            <footer className="flex items-center justify-between gap-2 border-t border-border px-3.5 py-2.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={chips.length === 0}
                onClick={() => onChange(EMPTY_FILTERS)}
              >
                Reset
              </Button>
              <PopoverClose asChild>
                <Button type="button" size="sm">
                  Done
                </Button>
              </PopoverClose>
            </footer>
          </PopoverContent>
        </Popover>

        <div className="flex flex-wrap items-center gap-1.5">
          {SAVED_VIEWS.map((view) => {
            const Icon = view.icon;
            const on = Object.entries(view.patch).every(
              ([k, v]) => value[k as keyof AuditFilters] === v,
            );
            return (
              <Button
                key={view.id}
                type="button"
                size="sm"
                variant={on ? 'secondary' : 'ghost'}
                className={cn('h-7', on && 'ring-1 ring-border-strong')}
                onClick={() => onChange(on ? invert(view.patch) : view.patch)}
              >
                <Icon size={12} />
                <span className="ml-1.5">{view.label}</span>
              </Button>
            );
          })}
          {/* Same range the panel's "Today" preset sets, so the two controls
              can't disagree about what today means. */}
          <Button
            type="button"
            size="sm"
            variant={todayActive ? 'secondary' : 'ghost'}
            className={cn('h-7', todayActive && 'ring-1 ring-border-strong')}
            onClick={() => onChange(todayActive ? { from: '', to: '' } : TODAY_RANGE())}
          >
            Today
          </Button>
        </div>
      </div>

      {/* ── Applied filters ───────────────────────────────────────── */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => onChange(chip.reset)}
              className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-surface px-2.5 py-1 text-[11px] text-text-2 transition-colors hover:bg-surface-2"
            >
              {chip.label}
              <X size={11} aria-hidden />
              <span className="sr-only">Remove filter</span>
            </button>
          ))}
          {isDirty && (
            <Button type="button" variant="ghost" size="sm" className="h-6" onClick={onClear}>
              Clear all
            </Button>
          )}
        </div>
      )}

      {/* ── Triage strip ──────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-2.5 text-xs text-text-3">
        <span className="tabular-nums">
          <strong className="font-medium text-text-2">{total.toLocaleString()}</strong>{' '}
          {total === 1 ? 'event' : 'events'}
        </span>
        {triage.map((t) => (
          <React.Fragment key={t.id}>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={() => onChange(t.patch)}
              className={cn('underline-offset-2 hover:underline', t.tone)}
            >
              <span className="tabular-nums font-medium">{t.n}</span> {t.label}
            </button>
          </React.Fragment>
        ))}
        {facets && triage.length === 0 && total > 0 && (
          <>
            <span aria-hidden>·</span>
            <span>all signed, nothing deleted</span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One labelled control in the filter panel.
 *
 * The micro-label carries the naming, so the controls themselves stay
 * unadorned and the panel reads as a list of questions rather than a form.
 */
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label
        htmlFor={htmlFor}
        className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-text-3"
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Reset every key a saved view sets, so clicking it again turns it off. */
function invert(patch: Partial<AuditFilters>): Partial<AuditFilters> {
  const out: Partial<AuditFilters> = {};
  for (const key of Object.keys(patch) as (keyof AuditFilters)[]) {
    out[key] = EMPTY_FILTERS[key] as never;
  }
  return out;
}
