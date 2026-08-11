'use client';

import * as React from 'react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { NumberedPagination } from '@/components/ui/numbered-pagination';
import { useMinDuration } from '@/hooks/use-min-duration';
import { clampInt, oneOf, useUrlSearchBox, useUrlState } from '@/hooks/use-url-state';
import { usePermission } from '@/hooks/use-permission';
import {
  AUDIT_ACTION_LABEL,
  AUDIT_SEVERITY_LABEL,
  AUDIT_SUBJECT_TABLE_LABEL,
  auditApi,
  type ApiAuditAction,
  type ApiAuditSeverity,
  type ApiAuditSubjectTable,
  type ApiTimelineEvent,
  type ApiTimelineFacets,
  type ListAuditEventsParams,
} from '@/lib/api/audit';
import { ApiError } from '@/lib/api/client';

import { AuditTimeline } from './audit-timeline';
import { AuditFiltersBar, type AuditFilters } from './audit-filters';
import { AuditDetailSheet } from './audit-detail-sheet';
import { MovementDetailSheet } from './movement-detail-sheet';

/**
 * Every piece of view state this page has, as query-string defaults. A value
 * equal to its default is left out of the URL, so an unfiltered viewer stays
 * ``/audit`` and a filtered one carries exactly the filters that are on.
 *
 * Module-level and constant — ``useUrlState`` reads it through a ref.
 */
const DEFAULTS = {
  page: 1,
  size: 50,
  q: '',
  subject: 'all',
  action: 'all',
  severity: 'all',
  signed: 'all',
  from: '',
  to: '',
};

/** The endpoint's ``limit`` ceiling. Anything larger is a 422, so clamp here. */
const MAX_PAGE_SIZE = 200;

/** ``YYYY-MM-DD`` — what ``<input type="date">`` produces. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const SUBJECT_VALUES = [
  'all',
  ...(Object.keys(AUDIT_SUBJECT_TABLE_LABEL) as ApiAuditSubjectTable[]),
] as const;
const ACTION_VALUES = ['all', ...(Object.keys(AUDIT_ACTION_LABEL) as ApiAuditAction[])] as const;
const SEVERITY_VALUES = [
  'all',
  ...(Object.keys(AUDIT_SEVERITY_LABEL) as ApiAuditSeverity[]),
] as const;
const SIGNED_VALUES = ['all', 'signed', 'unsigned'] as const;

/**
 * Audit viewer.
 *
 * Reads as a timeline of sentences rather than a grid of columns: each row
 * says who did what to which record, with the changed fields and the signer's
 * reason underneath. The machine-readable event type is still there, demoted
 * to a caption.
 *
 * Filters and the page number live in the URL, so a view can be refreshed,
 * bookmarked and sent to somebody — on an audit screen "the row I'm asking
 * about" has to be addressable. Paging and the merge of the two audit-worthy
 * tables happen in the database (``GET /v1/audit/timeline``), so the total and
 * every page are honest rather than a slice of two over-fetched windows.
 */
export function AuditPageClient() {
  const canView = usePermission('audit', 'view');
  const { value: raw, set, reset } = useUrlState(DEFAULTS);

  // Query params are hand-editable and outlive the build that wrote them, so
  // every one is validated before it reaches the API. A stale bookmark should
  // degrade to the unfiltered view, not to a 422 and an error screen.
  const urlState = React.useMemo(
    () => ({
      q: raw.q,
      from: ISO_DATE.test(raw.from) ? raw.from : '',
      to: ISO_DATE.test(raw.to) ? raw.to : '',
      subject: oneOf(raw.subject, SUBJECT_VALUES, 'all'),
      action: oneOf(raw.action, ACTION_VALUES, 'all'),
      severity: oneOf(raw.severity, SEVERITY_VALUES, 'all'),
      signed: oneOf(raw.signed, SIGNED_VALUES, 'all'),
      page: clampInt(raw.page, 1, 100_000, DEFAULTS.page),
      size: clampInt(raw.size, 1, MAX_PAGE_SIZE, DEFAULTS.size),
    }),
    [raw],
  );
  const { page, size } = urlState;

  const [events, setEvents] = React.useState<ApiTimelineEvent[]>([]);
  const [total, setTotal] = React.useState(0);
  const [facets, setFacets] = React.useState<ApiTimelineFacets | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);
  const [selectedAuditId, setSelectedAuditId] = React.useState<string | null>(null);
  const [selectedMovementId, setSelectedMovementId] = React.useState<string | null>(null);
  // Row the keyboard cursor is on. Also set on hover so the two never disagree.
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const searchRef = React.useRef<HTMLInputElement>(null);

  const [queryDraft, setQueryDraft] = useUrlSearchBox(urlState.q, (next) =>
    set({ q: next, page: 1 }),
  );

  const filters: AuditFilters = React.useMemo(
    () => ({
      q: urlState.q,
      subjectTable: urlState.subject as AuditFilters['subjectTable'],
      severity: urlState.severity as AuditFilters['severity'],
      action: urlState.action as AuditFilters['action'],
      signed: urlState.signed as AuditFilters['signed'],
      from: urlState.from,
      to: urlState.to,
    }),
    [urlState],
  );

  // Any filter change invalidates the page index — page 5 of the unfiltered
  // timeline is usually past the end of a filtered one.
  const applyFilters = React.useCallback(
    (patch: Partial<AuditFilters>) => {
      set({
        ...(patch.subjectTable !== undefined && { subject: patch.subjectTable }),
        ...(patch.severity !== undefined && { severity: patch.severity }),
        ...(patch.action !== undefined && { action: patch.action }),
        ...(patch.signed !== undefined && { signed: patch.signed }),
        ...(patch.from !== undefined && { from: patch.from }),
        ...(patch.to !== undefined && { to: patch.to }),
        page: 1,
      });
    },
    [set],
  );

  const clearFilters = React.useCallback(() => {
    setQueryDraft('');
    reset();
  }, [reset, setQueryDraft]);

  // Half-open bounds: ``from`` is inclusive, ``to`` is the start of the day
  // *after* the one picked, so "to: 5 Aug" includes everything on 5 Aug.
  const occurredFrom = urlState.from ? `${urlState.from}T00:00:00` : undefined;
  const occurredTo = React.useMemo(() => {
    if (!urlState.to) return undefined;
    const d = new Date(`${urlState.to}T00:00:00`);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 19);
  }, [urlState.to]);

  const params: ListAuditEventsParams = React.useMemo(() => {
    const p: ListAuditEventsParams = { limit: size, offset: (page - 1) * size };
    if (urlState.q.trim()) p.q = urlState.q.trim();
    if (urlState.subject !== 'all') {
      p.subjectTable = urlState.subject as NonNullable<ListAuditEventsParams['subjectTable']>;
    }
    if (urlState.severity !== 'all') {
      p.severity = urlState.severity as NonNullable<ListAuditEventsParams['severity']>;
    }
    if (urlState.action !== 'all') {
      p.action = urlState.action as NonNullable<ListAuditEventsParams['action']>;
    }
    if (urlState.signed !== 'all') p.signed = urlState.signed === 'signed';
    if (occurredFrom) p.occurredFrom = occurredFrom;
    if (occurredTo) p.occurredTo = occurredTo;
    return p;
  }, [
    size,
    page,
    urlState.q,
    urlState.subject,
    urlState.severity,
    urlState.action,
    urlState.signed,
    occurredFrom,
    occurredTo,
  ]);

  React.useEffect(() => {
    if (!canView) return;
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);
    auditApi
      .timeline(params, { signal: ctrl.signal })
      .then((resp) => {
        setEvents(resp.items);
        setTotal(resp.total);
        setFacets(resp.facets);
        // The cursor pointed at a row from the previous result set.
        setActiveId(resp.items[0]?.id ?? null);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load audit events.',
        );
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [canView, params, reload]);

  // Shown on every fetch, not just the first — a page change, a filter or a
  // search replaces every row. Held briefly so a fast fetch doesn't flash it.
  const showSkeleton = useMinDuration(loading);

  const pageCount = Math.max(1, Math.ceil(total / size));

  React.useEffect(() => {
    if (!loading && page > pageCount) set({ page: pageCount });
  }, [loading, page, pageCount, set]);

  const openRow = React.useCallback((e: ApiTimelineEvent) => {
    if (e.source === 'movement') setSelectedMovementId(e.id);
    else setSelectedAuditId(e.id);
  }, []);

  const sheetOpen = selectedAuditId !== null || selectedMovementId !== null;

  // ── Keyboard navigation ────────────────────────────────────────────
  // Auditors scan hundreds of rows; a mouse round-trip per row is the real
  // cost of this screen. ``/`` focuses search, j/k walk the list, Enter opens.
  React.useEffect(() => {
    if (!canView) return;
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el?.isContentEditable === true;

      if (ev.key === '/' && !typing) {
        ev.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      // Let the field's own Escape (and the sheet's) win before we do anything.
      if (ev.key === 'Escape' && typing) {
        searchRef.current?.blur();
        return;
      }
      if (typing || sheetOpen || ev.metaKey || ev.ctrlKey || ev.altKey) return;

      if (ev.key === 'j' || ev.key === 'k' || ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (events.length === 0) return;
        ev.preventDefault();
        const forward = ev.key === 'j' || ev.key === 'ArrowDown';
        const at = events.findIndex((e) => e.id === activeId);
        const next = at === -1 ? 0 : Math.min(events.length - 1, Math.max(0, at + (forward ? 1 : -1)));
        setActiveId(events[next]?.id ?? null);
        return;
      }
      if (ev.key === 'Enter' && activeId) {
        const row = events.find((e) => e.id === activeId);
        if (row) {
          ev.preventDefault();
          openRow(row);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canView, events, activeId, sheetOpen, openRow]);

  if (!canView) {
    return (
      <>
        <PageHeader title="Audit log" />
        <div className="px-6 py-5 sm:px-8">
          <EmptyState
            title="You do not have access to the audit log."
            hint="Ask an admin to grant you the audit:view permission."
          />
        </div>
      </>
    );
  }

  const safePage = Math.min(page, pageCount);

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every change to a record and every movement of material, newest first."
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="p-4">
          <AuditFiltersBar
            value={filters}
            onChange={applyFilters}
            queryDraft={queryDraft}
            onQueryDraftChange={setQueryDraft}
            onClear={clearFilters}
            facets={showSkeleton ? null : facets}
            total={total}
            searchRef={searchRef}
          />

          <div className="mt-2">
            {loadError ? (
              <EmptyState
                title="Couldn't load audit events"
                hint={loadError}
                action={<Button onClick={() => setReload((n) => n + 1)}>Retry</Button>}
              />
            ) : (
              <AuditTimeline
                events={events}
                loading={showSkeleton}
                onSelect={openRow}
                activeId={activeId}
                onActiveChange={setActiveId}
              />
            )}
          </div>

          {total > 0 && !loadError && (
            <NumberedPagination
              page={safePage}
              pageCount={pageCount}
              pageSize={size}
              total={total}
              startIdx={(safePage - 1) * size}
              rowsOnPage={events.length}
              onPageChange={(next) => set({ page: next })}
              onPageSizeChange={(next) => set({ size: next, page: 1 })}
              pageSizeOptions={[25, 50, 100, 200]}
              noun="event"
            />
          )}

          <p className="mt-3 text-[11px] text-text-3">
            <kbd className="rounded border border-border px-1">/</kbd> search ·{' '}
            <kbd className="rounded border border-border px-1">j</kbd>
            <kbd className="ml-0.5 rounded border border-border px-1">k</kbd> move ·{' '}
            <kbd className="rounded border border-border px-1">↵</kbd> open
          </p>
        </Card>
      </div>

      <AuditDetailSheet
        open={selectedAuditId !== null}
        onOpenChange={(o) => {
          if (!o) setSelectedAuditId(null);
        }}
        eventId={selectedAuditId}
      />

      <MovementDetailSheet
        open={selectedMovementId !== null}
        onOpenChange={(o) => {
          if (!o) setSelectedMovementId(null);
        }}
        movementId={selectedMovementId}
      />
    </>
  );
}
