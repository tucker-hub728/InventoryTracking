'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Boxes, CheckCircle2, Factory, Wrench, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { NumberedPagination } from '@/components/ui/numbered-pagination';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { ItemLink } from '@/components/inventory/item-link';
import { FLOOR_TABS } from '@/components/production/floor-tabs';
import { KanbanPanel } from '@/components/production/kanban-panel';
import { ApiError } from '@/lib/api/client';
import { locationNodesApi, type LocationNode } from '@/lib/api/location-nodes';
import {
  kitsApi,
  type ApiFloorKit,
  type ApiFloorKitCancelled,
  type ApiFloorKitConsumed,
  type ApiFloorKitCounts,
  type ApiFloorKitsResponse,
} from '@/lib/api/kits';
import { cn } from '@/lib/utils';

interface Props {
  nodeId: string;
  /** The URL segment; anything unknown falls back to the first tab. */
  tab: string;
}

/**
 * A single production floor: what is building on it, what it has consumed, and
 * what was cancelled after producing here.
 *
 * Split out of the Production list's slide-out (client 2026-07-28) because a
 * busy floor carries far too much for a panel — Clean Room 1 alone has 135
 * closed kits. Each tab is its own URL and its own page of rows, so only the
 * section being looked at is fetched.
 */
export function ProductionFloorClient({ nodeId, tab }: Props) {
  const router = useRouter();
  const active = FLOOR_TABS.find((t) => t.seg === tab) ?? FLOOR_TABS[0]!;

  const [floor, setFloor] = React.useState<LocationNode | null>(null);
  const [data, setData] = React.useState<ApiFloorKitsResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(15);

  // A tab or page-size change returns to page 1 — otherwise you can be stranded
  // on a page that doesn't exist in the new section.
  React.useEffect(() => {
    setPage(1);
  }, [active.seg, pageSize]);

  React.useEffect(() => {
    const ctrl = new AbortController();
    locationNodesApi
      .get(nodeId, { signal: ctrl.signal })
      .then(setFloor)
      .catch(() => {});
    return () => ctrl.abort();
  }, [nodeId]);

  React.useEffect(() => {
    // The Kanban tab is a stock view, not a kit section — it fetches its own
    // data inside <KanbanPanel/>, so skip the kits request entirely.
    if (active.kind !== 'kits') return;
    const ctrl = new AbortController();
    setData(null);
    setLoadError(null);
    kitsApi
      .onFloor(nodeId, {
        section: active.section,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        signal: ctrl.signal,
      })
      .then(setData)
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load this floor.');
      });
    return () => ctrl.abort();
    // ``active`` is one of the FLOOR_TABS module constants, so its identity is
    // stable across renders — depending on the object is safe and covers both
    // the segment and the section it carries.
  }, [nodeId, active, page, pageSize]);

  const counts: ApiFloorKitCounts = data?.counts ?? {
    in_production: 0,
    closed: 0,
    cancelled: 0,
  };
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const startIdx = (page - 1) * pageSize;

  // If a delete/close drops the current page past the end, step back.
  React.useEffect(() => {
    if (data && total > 0 && page > pageCount) setPage(pageCount);
  }, [data, total, page, pageCount]);

  // Null on the Kanban tab, which is a stock view rather than a kit section.
  const section = active.kind === 'kits' ? active.section : null;

  const rows =
    section === 'in_production'
      ? (data?.active ?? [])
      : section === 'closed'
        ? (data?.completed ?? [])
        : (data?.cancelled ?? []);

  const wip = (data?.active ?? []).reduce((a, k) => a + k.on_floor_total, 0);

  return (
    <>
      <PageHeader
        title={floor?.name ?? 'Production floor'}
        crumbs={[{ label: 'Production', href: '/production' }, { label: floor?.name ?? '…' }]}
        subtitle={
          <span className="flex items-center gap-2 text-xs text-text-3">
            <Factory size={13} className="text-accent" />
            {counts.in_production} building
            {section === 'in_production' && wip > 0 && (
              <> · {wip} unit{wip === 1 ? '' : 's'} of WIP</>
            )}{' '}
            · {counts.closed} closed here
            {counts.cancelled > 0 && <> · {counts.cancelled} cancelled after producing</>}
          </span>
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="min-w-0 overflow-hidden">
          <div className="scroll-strip border-b border-border px-4">
            <nav
              className="inline-flex items-center justify-start gap-1"
              aria-label="Floor sections"
            >
              {FLOOR_TABS.map((t, i) => {
                const isActive = t.seg === active.seg;
                // The kit-state tabs and the Kanban stock view are different
                // kinds of thing; a rule keeps Kanban from reading as a fourth
                // kit state (see floor-tabs.ts).
                const startsNewGroup = i > 0 && t.kind !== FLOOR_TABS[i - 1]!.kind;
                return (
                  <React.Fragment key={t.seg}>
                    {startsNewGroup && (
                      <span aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-border" />
                    )}
                  <Link
                    key={t.seg}
                    href={`/production/${nodeId}/${t.seg}`}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      '-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3.5 py-2.5 text-sm font-normal text-text-2 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      isActive && 'border-text font-medium text-text',
                    )}
                  >
                    {t.label}
                  </Link>
                  </React.Fragment>
                );
              })}
            </nav>
          </div>

          <div className="space-y-2 px-4 py-4">
            {section === null ? (
              <KanbanPanel areaId={nodeId} />
            ) : loadError ? (
              <EmptyState
                icon={Factory}
                title="Couldn't load this floor"
                hint={loadError}
                action={
                  <button
                    className="text-sm text-accent hover:underline"
                    onClick={() => router.refresh()}
                  >
                    Retry
                  </button>
                }
              />
            ) : data === null ? (
              <p className="p-6 text-center text-xs text-text-3">Loading…</p>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={section === 'cancelled' ? XCircle : Factory}
                title={
                  section === 'in_production'
                    ? 'Nothing building here'
                    : section === 'closed'
                      ? 'Nothing closed here yet'
                      : 'No cancelled kits with output'
                }
                hint={
                  section === 'in_production'
                    ? 'Material appears here when a kit is issued to this floor.'
                    : section === 'closed'
                      ? 'Closed kits that built on this floor will be listed here.'
                      : 'Kits cancelled after producing units on this floor appear here. Cancelling without producing leaves nothing to account for.'
                }
              />
            ) : section === 'in_production' ? (
              (rows as ApiFloorKit[]).map((kit) => <ActiveKitCard key={kit.id} kit={kit} />)
            ) : section === 'closed' ? (
              (rows as ApiFloorKitConsumed[]).map((kit) => (
                <ConsumedKitCard key={kit.id} kit={kit} />
              ))
            ) : (
              (rows as ApiFloorKitCancelled[]).map((kit) => (
                <CancelledKitCard key={kit.id} kit={kit} />
              ))
            )}
          </div>

          {section !== null && !loadError && total > 0 && (
            <div className="border-t border-border px-4 py-3">
              <NumberedPagination
                page={page}
                pageCount={pageCount}
                pageSize={pageSize}
                total={total}
                startIdx={startIdx}
                rowsOnPage={rows.length}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                noun="kit"
              />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

// ── Kit cards ───────────────────────────────────────────────────────────────
// Markup carried over verbatim from the Production slide-out — the client
// asked for the card design to stay exactly as it was (2026-07-28).

/** An open kit: remaining WIP, batches produced so far, material consumed. */
function ActiveKitCard({ kit }: { kit: ApiFloorKit }) {
  return (
    <div className="rounded-lg border border-border bg-bg-elev">
      <Link
        href={`/reconciliation/${kit.id}`}
        className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2.5 transition-colors hover:bg-surface"
      >
        <div className="min-w-0">
          {/* No status badge: the In-production tab already says the status. */}
          <span className="font-mono text-xs font-semibold text-accent">{kit.kit_number}</span>
          <div className="mt-0.5 truncate text-[11px] text-text-3">
            Building {kit.target_qty} × <span className="font-mono">{kit.item_number}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* What this kit has already produced (KIT-007 incremental) alongside
              its remaining WIP. */}
          {kit.good_qty > 0 && <Badge tone="success">{kit.good_qty} made</Badge>}
          <Badge tone="warning">{kit.on_floor_total} on floor</Badge>
          <ArrowRight size={14} className="text-text-3" />
        </div>
      </Link>

      {kit.lines.length > 0 && (
        <div className="px-3 pt-2">
          <SubHead icon={<Wrench size={11} />}>On floor</SubHead>
          <ul className="divide-y divide-border/50">
            {kit.lines.map((line) => (
              <li key={line.item_id} className="flex items-center justify-between gap-2 py-1.5">
                <ItemLink
                  itemNumber={line.item_number}
                  itemId={line.item_id}
                  className="truncate font-mono text-xs"
                />
                <span className="shrink-0 font-mono text-xs tabular-nums text-text">
                  {line.on_floor_qty}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Batches produced so far — each a minted lot (KIT-007). */}
      {kit.batches.length > 0 && (
        <div className="border-t border-border/60 px-3 pt-2">
          <SubHead icon={<Boxes size={11} />}>Batches produced</SubHead>
          <ul className="divide-y divide-border/50">
            {kit.batches.map((b, i) => (
              <li
                key={`${b.lot_number ?? 'lot'}-${i}`}
                className="flex items-center justify-between gap-2 py-1.5"
              >
                <span className="min-w-0 truncate">
                  <span className="font-mono text-xs text-text">{b.lot_number ?? '—'}</span>
                  {b.produced_at && (
                    <span className="ml-1.5 text-[11px] text-text-3">
                      · {new Date(b.produced_at).toLocaleDateString()}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-success">
                  {b.qty} made
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Consumed so far — material the produced batches drew from the floor. */}
      {kit.consumed.length > 0 && (
        <div className="border-t border-border/60 px-3 pt-2">
          <SubHead icon={<CheckCircle2 size={11} />}>Consumed so far</SubHead>
          <ul className="divide-y divide-border/50">
            {kit.consumed.map((line) => (
              <li key={line.item_id} className="flex items-center justify-between gap-2 py-1.5">
                <ItemLink
                  itemNumber={line.item_number}
                  itemId={line.item_id}
                  className="truncate font-mono text-xs"
                />
                <span className="shrink-0 font-mono text-xs tabular-nums text-text-3">
                  −{line.used_qty}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A closed kit: what it consumed on this floor. */
function ConsumedKitCard({ kit }: { kit: ApiFloorKitConsumed }) {
  return (
    <div className="rounded-lg border border-border bg-bg-elev">
      <Link
        href={`/reconciliation/${kit.id}`}
        className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2.5 transition-colors hover:bg-surface"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold text-accent">{kit.kit_number}</span>
            <Badge tone="success">{kit.good_qty ?? 0} made</Badge>
            {(kit.scrap_qty ?? 0) > 0 && <Badge tone="danger">{kit.scrap_qty} scrapped</Badge>}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-text-3">
            Built <span className="font-mono">{kit.item_number}</span>
            {kit.closed_at && ` · ${new Date(kit.closed_at).toLocaleDateString()}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone="neutral">{kit.consumed_total} consumed</Badge>
          <ArrowRight size={14} className="text-text-3" />
        </div>
      </Link>
      <ul className="divide-y divide-border/50">
        {kit.lines.map((line) => (
          <li key={line.item_id} className="flex items-center justify-between gap-2 px-3 py-1.5">
            <ItemLink
              itemNumber={line.item_number}
              itemId={line.item_id}
              className="truncate font-mono text-xs"
            />
            <span className="shrink-0 font-mono text-xs tabular-nums text-text-3">
              −{line.used_qty}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A kit cancelled AFTER producing here. The cancel returns leftover material to
 *  inventory but does NOT undo produced batches — those units are real stock on
 *  real lots, so the floor still accounts for them (client 2026-07-28). */
function CancelledKitCard({ kit }: { kit: ApiFloorKitCancelled }) {
  return (
    <div className="border-danger-soft rounded-lg border bg-bg-elev">
      <Link
        href={`/reconciliation/${kit.id}`}
        className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2.5 transition-colors hover:bg-surface"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* No "Cancelled" badge: the Cancelled tab already says the status. */}
            <span className="font-mono text-xs font-semibold text-accent">{kit.kit_number}</span>
            <Badge tone="success">{kit.good_qty ?? 0} made</Badge>
            {(kit.scrap_qty ?? 0) > 0 && <Badge tone="danger">{kit.scrap_qty} scrapped</Badge>}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-text-3">
            Built <span className="font-mono">{kit.item_number}</span>
            {kit.cancelled_at &&
              ` · cancelled ${new Date(kit.cancelled_at).toLocaleDateString()}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone="neutral">{kit.consumed_total} consumed</Badge>
          <ArrowRight size={14} className="text-text-3" />
        </div>
      </Link>

      {/* The batches it managed to produce before being cancelled — these units
          are in stock, not destroyed. */}
      {kit.batches.length > 0 && (
        <div className="border-b border-border/50 px-3 py-2">
          <SubHead icon={<Boxes size={11} />}>Produced before cancelling</SubHead>
          <ul className="mt-1 space-y-1">
            {kit.batches.map((b, i) => (
              <li
                key={`${b.lot_number ?? 'lot'}-${i}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate font-mono text-xs text-text-2">
                  {b.lot_number ?? '—'}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-success">
                  +{b.qty}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {kit.lines.length > 0 && (
        <ul className="divide-y divide-border/50">
          {kit.lines.map((line) => (
            <li key={line.item_id} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <ItemLink
                itemNumber={line.item_number}
                itemId={line.item_id}
                className="truncate font-mono text-xs"
              />
              <span className="shrink-0 font-mono text-xs tabular-nums text-text-3">
                −{line.used_qty}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Small labelled divider inside a kit card (On floor / Batches / Consumed). */
function SubHead({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-text-3">
      {icon}
      {children}
    </div>
  );
}
