'use client';

import * as React from 'react';
import { ArrowLeftRight, ShieldCheck } from 'lucide-react';

import { useMinDuration } from '@/hooks/use-min-duration';
import { EmptyState } from '@/components/shared/empty-state';
import { TableSkeleton } from '@/components/shared/table-skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LocationLink } from '@/components/locations/location-link';
import { TransferDialog } from '@/components/locations/transfer-dialog';
import { LotLink } from '@/components/inventory/lot-link';
import { ReleaseStateBadge } from '@/components/inventory/release-state-badge';
import { ReleaseStateDialog } from '@/components/inventory/release-state-dialog';
import { selectIsAdminOrAbove, useAuthStore } from '@/stores/auth.store';
import { ApiError } from '@/lib/api/client';
import { itemsApi, type ApiItemStockLocation } from '@/lib/api/items';
import { RELEASE_STATE_OPTIONS, type LotReleaseState } from '@/lib/api/lots';
import { expiryStatus } from '@/lib/inventory-helpers';
import { cn, formatNumber } from '@/lib/utils';

/** One release-state filter chip. Local to this tab — the only list where
 *  narrowing by release state is a question anyone asks. */
function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        active
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-border text-text-2 hover:border-accent/50 hover:bg-surface',
      )}
    >
      {label}
    </button>
  );
}

interface Props {
  item: { uuid: string; id: string; desc: string };
  /** Days before expiry at which a lot is flagged — the item's own setting. */
  nearExpiryThresholdDays: number;
  /** True when the operator may sign a transfer (``inventory:sign``). */
  canSign: boolean;
  /** Re-read the item after a transfer, so the header totals stay honest. */
  onChanged: () => void;
}

/**
 * "Stock by location" tab — where this item physically sits right now, a row
 * per (lot × storage location).
 *
 * REQ-2026-07-01-INV-007 asks that drilling into an item reveal its storage
 * location(s); the Unit Ledger answers *what moved*, not *where it is*. The
 * per-row Transfer action is the inventory-workspace half of
 * REQ-2026-07-15-TRX-001 (refined 2026-07-22) — it opens the same transfer the
 * location view opens, with this row pre-selected as the source.
 *
 * WIP held by an open kit on a production floor is excluded server-side: it is
 * not available stock, and a kit's Return step is how it comes back.
 */
export function ItemStockLocationsTab({
  item,
  nearExpiryThresholdDays,
  canSign,
  onChanged,
}: Props) {
  const [rows, setRows] = React.useState<ApiItemStockLocation[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [transferFrom, setTransferFrom] = React.useState<{
    lot_id: string;
    node_id: string;
  } | null>(null);
  // Held briefly — the fetch returns in ~20ms, too fast to see otherwise.
  const showSkeleton = useMinDuration(loading && rows.length === 0);
  /** Release state to narrow to, or null for "everything" (STS-001). */
  const [stateFilter, setStateFilter] = React.useState<LotReleaseState | null>(null);
  /** The lot whose release state is being decided, or null. */
  const [releaseLot, setReleaseLot] = React.useState<{
    id: string;
    lot_number: string;
    release_state: LotReleaseState | null;
  } | null>(null);
  // Admin / super admin only — mirrors the backend's ``_require_admin``. An
  // operator holds ``inventory:sign`` and can transfer, but must not release
  // the batch they just made (STS-002).
  const canDecide = useAuthStore(selectIsAdminOrAbove);

  const load = React.useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      return itemsApi
        .stockLocations(item.uuid, { signal })
        .then(setRows)
        .catch((err) => {
          if ((err as DOMException)?.name === 'AbortError') return;
          setError(err instanceof ApiError ? err.message : 'Failed to load stock.');
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        });
    },
    [item.uuid],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const total = rows.reduce((sum, r) => sum + r.qty, 0);

  // Which states this item actually has stock in. Offering the full four on an
  // item that only ever sits in one of them is four dead controls; offering
  // none at all (a consumable) hides the row of chips entirely.
  const presentStates = RELEASE_STATE_OPTIONS.filter((o) =>
    rows.some((r) => r.release_state === o.code),
  );
  const visibleRows = stateFilter
    ? rows.filter((r) => r.release_state === stateFilter)
    : rows;

  if (error) return <EmptyState title="Couldn't load stock" hint={error} />;
  if (showSkeleton) {
    return (
      <div className="p-4">
        <TableSkeleton
          rows={3}
          columns={5}
          className="rounded-lg border border-border"
          label="Loading stock…"
        />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Not stocked anywhere"
        hint="Once this item is received into a location it will show up here."
      />
    );
  }

  return (
    <>
      <div className="p-4">
        {/* Only shown when this item has release-tracked stock at all, so the
            common case (consumables, raw materials) is untouched. */}
        {presentStates.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11px] uppercase tracking-wider text-text-3">
              Quality status
            </span>
            <FilterChip
              label={`All (${rows.length})`}
              active={stateFilter === null}
              onClick={() => setStateFilter(null)}
            />
            {presentStates.map((o) => (
              <FilterChip
                key={o.code}
                label={`${o.label} (${rows.filter((r) => r.release_state === o.code).length})`}
                active={stateFilter === o.code}
                onClick={() => setStateFilter(stateFilter === o.code ? null : o.code)}
              />
            ))}
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-border">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface text-left text-[11px] uppercase tracking-wider text-text-3">
                  <th className="px-4 py-2.5 font-medium">Location</th>
                  <th className="px-4 py-2.5 font-medium">Lot</th>
                  <th className="px-4 py-2.5 text-right font-medium">Qty</th>
                  <th className="px-4 py-2.5 font-medium">Expiry</th>
                  {canSign && <th className="px-4 py-2.5" />}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const exp = expiryStatus(r.expiration_date, nearExpiryThresholdDays);
                  return (
                    <tr
                      key={`${r.lot_id}:${r.node_id}`}
                      className="border-b border-border/60 last:border-b-0"
                    >
                      <td className="px-4 py-2.5">
                        <LocationLink
                          nodeId={r.node_id}
                          // The API sends the full breadcrumb; show it whole so
                          // "Shelf B" is never ambiguous between two areas.
                          name={r.location}
                          path={r.location}
                        />
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-text-2">
                        {/* Click through to the lot, as the Unit Ledger and a
                            location's contents already do — the lot is the
                            thing you follow when a row looks wrong. */}
                        <span className="flex flex-wrap items-center gap-1.5">
                          <LotLink lotId={r.lot_id} lotNumber={r.lot_number} />
                          {/* Nothing renders for a lot with no release
                              workflow, which is most of them. */}
                          <ReleaseStateBadge state={r.release_state} size="xs" />
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                        {formatNumber(r.qty)}
                      </td>
                      <td className="px-4 py-2.5">
                        {r.expiration_date ? (
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-xs text-text-2">
                              {r.expiration_date}
                            </span>
                            {/* Expired stock is flagged but still transferable —
                                no requirement blocks relocating it, and
                                REQ-2026-07-01-LOC-005 de-scoped a quarantine
                                location, so blocking would strand it. */}
                            {exp && exp.tone !== 'success' && (
                              <Badge tone={exp.tone}>{exp.label}</Badge>
                            )}
                          </span>
                        ) : (
                          <span className="text-xs text-text-3">—</span>
                        )}
                      </td>
                      {canSign && (
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* The release action sits beside Transfer because this
                                is the row an operator is already looking at
                                when they ask "can this batch go out?". Shown
                                only for release-tracked lots, and only to the
                                roles the backend will accept (STS-002). */}
                            {canDecide && r.release_state && (
                              <Button
                                size="sm"
                                aria-label={`Change quality status of ${r.lot_number ?? 'this lot'}`}
                                onClick={() =>
                                  setReleaseLot({
                                    id: r.lot_id,
                                    lot_number: r.lot_number ?? r.lot_id.slice(0, 8),
                                    release_state: r.release_state,
                                  })
                                }
                              >
                                <ShieldCheck size={13} /> Quality status
                              </Button>
                            )}
                            <Button
                              size="sm"
                              aria-label={`Transfer ${r.lot_number ?? 'stock'} from ${r.location}`}
                              onClick={() =>
                                setTransferFrom({ lot_id: r.lot_id, node_id: r.node_id })
                              }
                            >
                              <ArrowLeftRight size={13} /> Transfer
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-surface/60">
                  <td className="px-4 py-2.5 text-xs text-text-3" colSpan={2}>
                    {rows.length} location{rows.length === 1 ? '' : 's'}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                    {formatNumber(total)}
                  </td>
                  <td className="px-4 py-2.5" colSpan={canSign ? 2 : 1} />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>

      <TransferDialog
        open={Boolean(transferFrom)}
        onOpenChange={(o) => !o && setTransferFrom(null)}
        item={item}
        presetSource={transferFrom}
        onDone={() => {
          void load();
          onChanged();
        }}
      />

      <ReleaseStateDialog
        open={releaseLot !== null}
        onOpenChange={(o) => !o && setReleaseLot(null)}
        // A row action already names the batch, so there is nothing to pick.
        lots={releaseLot ? [releaseLot] : []}
        onDone={() => {
          setReleaseLot(null);
          // A lot can sit in several locations, so re-read the whole tab rather
          // than patching the one row that was clicked.
          void load();
        }}
      />
    </>
  );
}
