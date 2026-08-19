'use client';

/**
 * Debit-and-gone locations — where material goes to leave inventory
 * (REQ-2026-08-04-TRX-001/002).
 *
 * These are the client's PD and R&D labs, QC, scrap. Issuing material to one
 * removes it from controlled inventory permanently; nothing is stored there.
 *
 * ── Why this is its own section, and what it must NOT become ────────────────
 *
 * These rows are ``storage_category`` nodes in the STORAGE room carrying
 * ``is_scrap``, exactly as before — this screen is a FILTERED VIEW of them, not
 * a room, not a node type, not a new level in the tree. That distinction is
 * load-bearing:
 *
 *   * Debit-and-gone is a TRANSACTION, not a location type. The client rejected
 *     a scrap-node / scrap-location-type model twice. Turning this page into a
 *     real room would be that model arriving through the back door.
 *   * "Issued AND stored" is unrepresentable because the two endpoints take
 *     DISJOINT destination node types — ``POST /allocations/transfer*`` takes a
 *     storage node, ``POST /issues`` takes a ``storage_category`` with
 *     ``is_scrap``. Give these their own node type and that property is gone.
 *
 * What changed on 2026-08-19 is only where they are SHOWN. They used to sit in
 * the Storage grid beside the storage locations, which mixed two cards answering
 * different questions ("what is in here" vs "what left through here") under one
 * set of stat tiles that could only ever describe the storage half. Since a
 * debit-and-gone location is disposition-only — no sub-types, no units, no stock
 * — it had nothing in common with the cards around it but the row type.
 *
 * A card grid, like Storage: the interesting content is three small numbers per
 * location, which read better side by side than as mostly-empty columns.
 */

import * as React from 'react';
import Link from 'next/link';
import { Clock, MinusCircle, Plus } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Stat } from '@/components/rooms/storage-leaf-grid';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/client';
import { issuesApi, type IssuedSummary } from '@/lib/api/issues';
import { locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';
import { STORAGE_ROOM_CODE } from '@/components/storage/storage-groups';
import { selectIsSuperAdmin, useAuthStore } from '@/stores/auth.store';

import { CreateDebitAndGoneLocationDialog } from './create-location-dialog';

/** Where this section lives, without a trailing slash. */
export const DEBIT_AND_GONE_HREF = '/debit-and-gone';

/** URL for one debit-and-gone location's disposition log. */
export function debitAndGoneHref(nodeId: string): string {
  return `${DEBIT_AND_GONE_HREF}/${nodeId}`;
}

/** "3 days ago" — a disposition log is read for recency, not for a timestamp.
 *  Falls back to the date once the gap stops being something anyone counts. */
export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(then).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

export function DebitAndGoneClient() {
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);

  const [room, setRoom] = React.useState<NodeTree | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  /** node id → what has been issued there. Absent until something has been. */
  const [issued, setIssued] = React.useState<Map<string, IssuedSummary>>(new Map());

  const reload = React.useCallback(async (signal?: AbortSignal) => {
    setLoadError(null);
    try {
      // Both at once: the tree names the locations, the summary says what each
      // has taken — and the tree cannot know that, because none of it is stock.
      // A failed summary must not blank the page; those cards fall back to the
      // "nothing issued yet" state, which is also what an empty result means.
      const [rooms, summary] = await Promise.all([
        locationNodesApi.freezerTree({ signal }),
        issuesApi.summary({ signal }).catch(() => [] as IssuedSummary[]),
      ]);
      setRoom(rooms.find((r) => r.code === STORAGE_ROOM_CODE) ?? null);
      setIssued(new Map(summary.map((r) => [r.node_id, r])));
      setLoaded(true);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(
        err instanceof ApiError ? err.message : 'Failed to load debit-and-gone locations.',
      );
    } finally {
      // An ABORTED request must not clear `loading`: StrictMode mounts, aborts
      // and remounts in development, so clearing it here would leave
      // loading=false with no data and flash the empty state.
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  /** The scrap half of the Storage room, by name. */
  const locations = React.useMemo(
    () =>
      (room?.children ?? [])
        .filter((c) => c.is_scrap)
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
        ),
    [room],
  );
  /** Every name in the room, scrap or not — the create dialog checks against
   *  all of them, because these locations are siblings of the storage ones in
   *  the tree and the server's uniqueness rule does not care which kind. */
  const allNames = React.useMemo(
    () => (room?.children ?? []).map((c) => c.name),
    [room],
  );
  const none = loaded && !loadError && locations.length === 0;

  const totals = React.useMemo(() => {
    let qty = 0;
    let count = 0;
    for (const loc of locations) {
      const s = issued.get(loc.id);
      if (!s) continue;
      qty += s.total_qty;
      count += s.issue_count;
    }
    return { qty, count };
  }, [locations, issued]);

  return (
    <>
      <PageHeader
        title="Debit-and-gone"
        subtitle={
          <span className="text-text-3">
            Material issued to one of these leaves inventory permanently
          </span>
        }
        actions={
          isSuperAdmin && !none ? (
            <Button type="button" variant="primary" onClick={() => setCreating(true)}>
              <Plus size={15} />
              <span className="ml-1.5">Create new location</span>
            </Button>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        {loadError ? (
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title="Couldn't load these locations"
              hint={loadError}
              action={<Button onClick={() => void reload()}>Retry</Button>}
            />
          </div>
        ) : none && !loading ? (
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              icon={MinusCircle}
              title="No debit-and-gone locations yet"
              hint={
                isSuperAdmin
                  ? 'Create one for each place material is sent to be used up — a PD or R&D lab, QC, scrap. Until one exists, nothing can be issued.'
                  : 'A Super Admin creates these. Until one exists, nothing can be issued.'
              }
              action={
                isSuperAdmin ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus size={15} />
                    <span className="ml-1.5">Create new location</span>
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            {/* Three tiles that are all about what LEFT. There is deliberately
                no stock figure: these locations hold nothing, and a zero beside
                the others would invite reading it as "nothing here yet". */}
            <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat
                label="Locations"
                value={loading ? '—' : String(locations.length)}
                sub="issue destinations"
              />
              <Stat
                label="Units issued"
                value={loading ? '—' : totals.qty.toLocaleString()}
                sub="gone from inventory"
              />
              <Stat
                label="Transactions"
                value={loading ? '—' : totals.count.toLocaleString()}
                sub={totals.count === 0 ? 'nothing issued yet' : 'across all locations'}
              />
            </div>

            {loading ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-32 rounded-lg" />
                ))}
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {locations.map((loc) => (
                  <LocationCard
                    key={loc.id}
                    location={loc}
                    issued={issued.get(loc.id) ?? null}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {creating && (
        <CreateDebitAndGoneLocationDialog
          existingNames={allNames}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void reload();
          }}
        />
      )}
    </>
  );
}

/** One location: what it has taken, over how many transactions, and when last. */
function LocationCard({
  location,
  issued,
}: {
  location: NodeTree;
  issued: IssuedSummary | null;
}) {
  return (
    <li>
      <Link
        href={debitAndGoneHref(location.id)}
        className="group flex h-full flex-col rounded-lg border border-border bg-bg-elev transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="flex items-start justify-between gap-3 p-4 pb-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text">{location.name}</p>
            <p className="mt-0.5 text-xs text-text-3">Disposition only</p>
          </div>
          {/* No badge saying "Debit-and-gone" — every card on this page is one,
              and a label repeated on all of them carries no information. The
              page title says it once. */}
        </div>

        <div className="mt-auto border-t border-border px-4 py-3">
          {issued ? (
            <>
              <div className="flex items-end gap-6">
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wider text-text-3">
                    Units issued
                  </div>
                  <div className="mt-0.5 font-mono text-lg tabular-nums text-text">
                    {issued.total_qty.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wider text-text-3">
                    Transactions
                  </div>
                  <div className="mt-0.5 font-mono text-lg tabular-nums text-text-2">
                    {issued.issue_count.toLocaleString()}
                  </div>
                </div>
              </div>
              {issued.last_issued_at && (
                <p className="mt-2 flex items-center gap-1.5 text-[11px] text-text-3">
                  <Clock size={11} className="shrink-0" />
                  Last issued {formatRelative(issued.last_issued_at)}
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-text-3">
              Nothing issued here yet. Material sent here leaves inventory for good.
            </p>
          )}
        </div>
      </Link>
    </li>
  );
}
