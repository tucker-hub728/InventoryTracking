'use client';

import * as React from 'react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermission } from '@/hooks/use-permission';
import {
  auditApi,
  type ApiAuditEvent,
  type ListAuditEventsParams,
} from '@/lib/api/audit';
import {
  isMovementRow,
  mergeByOccurredAt,
  movementToAuditEvent,
} from '@/lib/api/audit-merge';
import { ApiError } from '@/lib/api/client';
import { movementsApi, type ApiMovement } from '@/lib/api/movements';

import { AuditTable } from './audit-table';
import {
  AuditFiltersBar,
  EMPTY_FILTERS,
  type AuditFilters,
} from './audit-filters';
import { AuditDetailSheet } from './audit-detail-sheet';
import { MovementDetailSheet } from './movement-detail-sheet';

const PAGE_SIZE = 50;

/**
 * Audit viewer page. Anchored on a single ``GET /v1/audit/events``
 * call per filter change. Pagination is cursor-less for v1 — the
 * client tracks ``offset`` and bumps it via Next/Prev. Total comes
 * back on every page so the footer stays accurate.
 *
 * Per-row click opens a side-sheet with the field-level diff and (if
 * the originating action was signed) the signature details — signer,
 * timestamp, attested meaning and the optional reason. There is no
 * signature image: the e-signature is the password re-authentication
 * (client decision, 2026-08-03).
 */
export function AuditPageClient() {
  const canView = usePermission('audit', 'view');

  const [filters, setFilters] = React.useState<AuditFilters>(EMPTY_FILTERS);
  const [page, setPage] = React.useState(0);
  // ``events`` is the merged, paginated view. ``movementIndex`` lets the
  // row-click dispatch open the movement detail sheet for synth rows
  // without re-fetching.
  const [events, setEvents] = React.useState<ApiAuditEvent[]>([]);
  const [movementIndex, setMovementIndex] = React.useState<
    Map<string, ApiMovement>
  >(new Map());
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selectedAuditId, setSelectedAuditId] = React.useState<string | null>(
    null,
  );
  const [selectedMovement, setSelectedMovement] =
    React.useState<ApiMovement | null>(null);

  // ``q`` is the only debounced field. Picking dropdowns / dates is
  // explicit and should fire immediately.
  const debouncedQuery = useDebouncedValue(filters.q, 200);

  // Half-open ISO bounds shared by both fetches (movements filter
  // these client-side, audit-events filter on the server).
  const occurredFrom = React.useMemo(
    () => (filters.from ? `${filters.from}T00:00:00` : undefined),
    [filters.from],
  );
  const occurredTo = React.useMemo(() => {
    if (!filters.to) return undefined;
    const d = new Date(`${filters.to}T00:00:00`);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 19);
  }, [filters.to]);

  // Whether each source should run for the current filter. When the
  // user picks "Movements", the audit-events query would just return
  // zero (movements aren't recorded there) — skipping it saves a round
  // trip and avoids the misleading total.
  const showAudit = filters.subjectTable !== 'app.stock_movements';
  const showMovements =
    filters.subjectTable === 'all' ||
    filters.subjectTable === 'app.stock_movements';

  const auditParams: ListAuditEventsParams = React.useMemo(() => {
    const p: ListAuditEventsParams = { limit: 200, offset: 0 };
    if (debouncedQuery.trim()) p.q = debouncedQuery.trim();
    if (filters.subjectTable !== 'all' && filters.subjectTable !== 'app.stock_movements') {
      p.subjectTable = filters.subjectTable;
    }
    if (filters.severity !== 'all') p.severity = filters.severity;
    if (filters.action !== 'all') p.action = filters.action;
    if (occurredFrom) p.occurredFrom = occurredFrom;
    if (occurredTo) p.occurredTo = occurredTo;
    return p;
  }, [
    debouncedQuery,
    filters.subjectTable,
    filters.severity,
    filters.action,
    occurredFrom,
    occurredTo,
  ]);

  // Reset to page 0 whenever a filter changes (otherwise a deep page
  // index can show "0 of N" while the new filter has plenty of rows).
  React.useEffect(() => {
    setPage(0);
  }, [
    debouncedQuery,
    filters.subjectTable,
    filters.severity,
    filters.action,
    filters.from,
    filters.to,
  ]);

  React.useEffect(() => {
    if (!canView) return;
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);

    // Movements API has no date / actor / search filters yet — we pull
    // a large page and apply the audit-page filters in memory. Capped
    // at 200 to match the backend ``Query(le=200)`` ceiling on
    // ``GET /movements`` (audit-events uses the same cap).
    const auditP = showAudit
      ? auditApi.list(auditParams, { signal: ctrl.signal })
      : Promise.resolve({ items: [], total: 0, limit: 0, offset: 0 });
    const movementsP = showMovements
      ? movementsApi.list({ limit: 200 }, { signal: ctrl.signal })
      : Promise.resolve({ items: [], total: 0, limit: 0, offset: 0 });

    Promise.all([auditP, movementsP])
      .then(([auditResp, movementsResp]) => {
        // Client-side filters for movements (audit was already
        // narrowed server-side).
        const q = debouncedQuery.trim().toLowerCase();
        const fromMs = occurredFrom
          ? new Date(occurredFrom).getTime()
          : -Infinity;
        const toMs = occurredTo ? new Date(occurredTo).getTime() : Infinity;
        const filteredMovements = movementsResp.items.filter((m) => {
          const ts = new Date(m.performed_at).getTime();
          if (ts < fromMs || ts >= toMs) return false;
          if (filters.action !== 'all' && filters.action !== 'created')
            return false;
          if (filters.severity !== 'all') {
            const sev = m.movement_type === 'discard' ? 'warning' : 'info';
            if (sev !== filters.severity) return false;
          }
          if (q) {
            const hay = `${m.movement_type} ${m.item_number ?? ''} ${
              m.item_description ?? ''
            } ${m.lot_number ?? ''} ${m.notes ?? ''}`.toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });

        const synth = filteredMovements.map(movementToAuditEvent);
        const merged = mergeByOccurredAt(auditResp.items, synth);

        // Stash the underlying movements by id so the row-click can
        // open the movement detail sheet without re-fetching.
        const idx = new Map<string, ApiMovement>();
        for (const m of filteredMovements) idx.set(m.id, m);

        setEvents(merged);
        setMovementIndex(idx);
        setTotal(auditResp.total + filteredMovements.length);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load audit events.',
        );
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [
    auditParams,
    canView,
    showAudit,
    showMovements,
    debouncedQuery,
    filters.action,
    filters.severity,
    occurredFrom,
    occurredTo,
  ]);

  // Paginate the merged result client-side. We overfetch both sources
  // (limit 200 each — the ``GET /movements`` and ``GET /audit/events``
  // ceilings) so for v1 MVP volumes the whole timeline fits and the
  // page nav just walks through it.
  const pageRows = React.useMemo(
    () => events.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [events, page],
  );

  // Declared before any early return so the hook call order stays stable
  // (react-hooks/rules-of-hooks). Used by the table rows below.
  const handleSelect = React.useCallback(
    (e: ApiAuditEvent) => {
      if (isMovementRow(e)) {
        const m = movementIndex.get(e.id);
        if (m) {
          setSelectedMovement(m);
          return;
        }
      }
      setSelectedAuditId(e.id);
    },
    [movementIndex],
  );

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

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const startIdx = page * PAGE_SIZE;
  const endIdx = Math.min(startIdx + pageRows.length, total);

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle={
          loading && total === 0
            ? 'Loading…'
            : `${total.toLocaleString()} events recorded`
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="p-4">
          <div className="mb-4">
            <AuditFiltersBar value={filters} onChange={setFilters} />
          </div>

          {loadError ? (
            <EmptyState
              title="Couldn't load audit events"
              hint={loadError}
              action={
                <Button
                  onClick={() => {
                    setFilters({ ...filters });
                  }}
                >
                  Retry
                </Button>
              }
            />
          ) : (
            <AuditTable
              events={pageRows}
              loading={loading}
              onSelect={handleSelect}
            />
          )}

          {total > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-text-3">
              <span>
                {startIdx + 1}–{endIdx} of {total.toLocaleString()}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </Button>
                <span>
                  Page {page + 1} of {pageCount}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={page + 1 >= pageCount}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
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
        open={selectedMovement !== null}
        onOpenChange={(o) => {
          if (!o) setSelectedMovement(null);
        }}
        movement={selectedMovement}
      />
    </>
  );
}
