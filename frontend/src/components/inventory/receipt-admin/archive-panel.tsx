'use client';

import * as React from 'react';
import { Archive, Eye, Loader2, RotateCcw, Search, ShieldCheck, X } from 'lucide-react';

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { toast } from '@/components/ui/sonner';
import { useAuthStore, selectIsSuperAdmin } from '@/stores/auth.store';
import { ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import {
  receivingApi,
  ORDER_STATUS_LABEL,
  type ArchivePolicy,
  type Order,
} from '@/lib/api/receiving';

const SEARCH_DEBOUNCE_MS = 250;
const PREVIEW_DEBOUNCE_MS = 350;
const ARCHIVED_PAGE_SIZE = 25;

/** "3 weeks ago" — the useful reading of a sweep timestamp is its age, not its
 *  clock time; the question being asked is "is the job still running?". */
function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return '—';
  }
}

/**
 * The Order retention policy, and the shelf it puts things on
 * (REQ-2026-07-15-DATA-001/002/003).
 *
 * Both halves live in one panel because they are one question — "what leaves
 * the working list, and how do I get it back?" — and splitting them would mean
 * an operator who archived something by accident has to go somewhere else to
 * undo it.
 *
 * The eligible-count previews the age being TYPED, not the one saved, so the
 * consequence of a change is visible before it is committed rather than after.
 */
export function ArchivePanel({
  open,
  onOpenChange,
  onChanged,
  onView,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Something moved between the working list and the archive — the list
   *  behind this panel is now stale. */
  onChanged: () => void;
  /** Open a found order in the ordinary order sheet. The panel closes; that
   *  sheet shows a way back here, because the operator was midway through a
   *  search when they asked to look at it. */
  onView: (order: Order) => void;
}) {
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);

  const [policy, setPolicy] = React.useState<ArchivePolicy | null>(null);
  const [days, setDays] = React.useState('');
  const [preview, setPreview] = React.useState<number | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [sweeping, setSweeping] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [archived, setArchived] = React.useState<Order[]>([]);
  // How many the CURRENT search matched. The total on the shelf comes from the
  // policy instead, so the count in the heading is right before any searching.
  const [matches, setMatches] = React.useState(0);
  const [listLoading, setListLoading] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [term, setTerm] = React.useState('');
  const [restoringId, setRestoringId] = React.useState<string | null>(null);

  const daysNum = Number(days);
  const daysValid = Number.isInteger(daysNum) && daysNum >= 1 && daysNum <= 3650;
  const dirty = policy !== null && daysValid && daysNum !== policy.archive_after_days;

  const loadPolicy = React.useCallback(async (signal?: AbortSignal) => {
    try {
      const p = await receivingApi.getArchivePolicy({ signal });
      setPolicy(p);
      setDays(String(p.archive_after_days));
      setPreview(p.eligible_now);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setError(err instanceof ApiError ? err.message : 'Failed to load the policy.');
    }
  }, []);

  // Bumped after a sweep or a restore to re-read the shelf. An explicit signal
  // beats re-running on a callback's identity: the fetch below then depends on
  // exactly three visible things — is the panel open, what is being searched
  // for, and has something moved — instead of on when React happens to rebuild
  // a memoised function.
  const [reloadTick, setReloadTick] = React.useState(0);
  const refresh = React.useCallback(() => setReloadTick((n) => n + 1), []);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    const ctrl = new AbortController();
    void loadPolicy(ctrl.signal);
    return () => ctrl.abort();
  }, [open, loadPolicy]);

  // Search FIRST — the archive is not a list to browse.
  //
  // After a year it holds most of the orders ever placed, and dumping 25
  // arbitrary ones into a panel answers nobody's question: you come here
  // knowing which order you want back. So nothing is fetched until there is
  // something to look for, which also keeps the panel from pulling a page of
  // orders (each with its lines and receive events) every time it opens.
  React.useEffect(() => {
    if (!open || !term) {
      setArchived([]);
      return;
    }
    const ctrl = new AbortController();
    setListLoading(true);
    receivingApi
      .listOrders({
        bucket: 'archived',
        q: term,
        limit: ARCHIVED_PAGE_SIZE,
        signal: ctrl.signal,
      })
      .then((resp) => {
        setArchived(resp.items);
        setMatches(resp.total);
      })
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to search the archive.');
      })
      .finally(() => setListLoading(false));
    return () => ctrl.abort();
  }, [open, term, reloadTick]);

  React.useEffect(() => {
    const id = setTimeout(() => setTerm(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // Preview the TYPED age. Skipped while it matches what's saved — that number
  // already came back with the policy.
  React.useEffect(() => {
    if (!open || !policy || !daysValid || daysNum === policy.archive_after_days) {
      if (policy && !dirty) setPreview(policy.eligible_now);
      return;
    }
    const ctrl = new AbortController();
    setPreviewing(true);
    const id = setTimeout(() => {
      receivingApi
        .getArchivePolicy({ days: daysNum, signal: ctrl.signal })
        .then((p) => setPreview(p.eligible_now))
        .catch(() => {})
        .finally(() => setPreviewing(false));
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [open, policy, daysNum, daysValid, dirty]);

  const savePolicy = async () => {
    if (!daysValid) return;
    setSaving(true);
    setError(null);
    try {
      const p = await receivingApi.updateArchivePolicy(daysNum);
      setPolicy(p);
      setPreview(p.eligible_now);
      toast.success('Policy saved', {
        description: `Finished orders archive after ${p.archive_after_days} days.`,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the policy.');
    } finally {
      setSaving(false);
    }
  };

  const sweepNow = async () => {
    setSweeping(true);
    setError(null);
    try {
      const res = await receivingApi.runArchiveSweep();
      toast.success(
        res.archived === 0 ? 'Nothing to archive' : `Archived ${res.archived} order(s)`,
        { description: `Anything finished for more than ${res.archive_after_days} days.` },
      );
      await loadPolicy();
      refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The sweep failed.');
    } finally {
      setSweeping(false);
    }
  };

  const restore = async (order: Order) => {
    setRestoringId(order.id);
    setError(null);
    try {
      await receivingApi.restoreOrder(order.id);
      toast.success(`${order.po_reference} restored`, {
        description: 'Back on the working list, unchanged.',
      });
      await loadPolicy();
      refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to restore the order.');
    } finally {
      setRestoringId(null);
    }
  };

  const shown = preview ?? policy?.eligible_now ?? 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[560px]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Archive size={17} aria-hidden /> Archive
          </SheetTitle>
          <SheetDescription>
            Completed orders move off the working list once they&apos;re old enough.
            Nothing is deleted — anything here can be put back.
          </SheetDescription>
        </SheetHeader>

        <SheetBody className="space-y-6">
          {error && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
            >
              {error}
            </p>
          )}

          {/* ── Policy ──────────────────────────────────────────────── */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-3">
                Policy
              </h3>
              {policy && (
                <span className="text-[11px] text-text-3">
                  Last run {timeAgo(policy.last_swept_at)}
                </span>
              )}
            </div>

            {policy === null ? (
              <Skeleton className="h-28 w-full rounded-lg" />
            ) : (
              <div className="rounded-lg border border-border bg-bg-elev p-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="archive-days"
                      className="block text-xs font-medium text-text-2"
                    >
                      Archive after
                    </label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="archive-days"
                        type="number"
                        min={1}
                        max={3650}
                        step={1}
                        value={days}
                        disabled={!isSuperAdmin}
                        onChange={(e) => setDays(e.target.value)}
                        className="w-28 font-mono"
                      />
                      <span className="text-sm text-text-2">days</span>
                    </div>
                  </div>

                  {isSuperAdmin && (
                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        variant="primary"
                        disabled={!dirty || saving}
                        onClick={() => void savePolicy()}
                      >
                        {saving && <Loader2 size={14} className="animate-spin" />} Save policy
                      </Button>
                      <Button disabled={sweeping} onClick={() => void sweepNow()}>
                        {sweeping ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Archive size={14} />
                        )}{' '}
                        Archive now
                      </Button>
                    </div>
                  )}
                </div>

                {!daysValid && days !== '' && (
                  <p className="mt-2 text-[11px] text-danger">
                    Enter a whole number of days between 1 and 3650.
                  </p>
                )}

                {/* The consequence, before it is committed. */}
                <div
                  className={cn(
                    'mt-3 rounded-md border px-3 py-2 text-xs',
                    dirty
                      ? 'border-warning/30 bg-warning/5 text-warning'
                      : 'border-border bg-surface text-text-2',
                  )}
                >
                  {previewing ? (
                    <span className="flex items-center gap-1.5 text-text-3">
                      <Loader2 size={12} className="animate-spin" /> counting…
                    </span>
                  ) : (
                    <>
                      <span className="font-mono font-semibold">{shown}</span>{' '}
                      {shown === 1 ? 'order is' : 'orders are'}{' '}
                      {dirty ? (
                        <>
                          eligible at <span className="font-mono">{daysNum}</span> days —
                          they archive when you save this.
                        </>
                      ) : (
                        'eligible right now.'
                      )}
                    </>
                  )}
                </div>

                <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-text-3">
                  <ShieldCheck size={13} className="mt-px shrink-0" aria-hidden />
                  Orders still awaiting stock are never archived, however old.
                </p>

                {!isSuperAdmin && (
                  <p className="mt-2 text-[11px] text-text-3">
                    Only a super admin can change the policy or run a sweep.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* ── The shelf ───────────────────────────────────────────── */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-3">
                Find an archived order
                {/* How many are on the shelf altogether — from the policy, so
                    it is right before any searching has happened. */}
                {(policy?.archived_total ?? 0) > 0 && (
                  <span className="ml-1.5 font-mono text-text-2">
                    {policy?.archived_total}
                  </span>
                )}
              </h3>
              <div className="w-[240px]">
                <Input
                  icon={Search}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Order #, item or lot…"
                  aria-label="Search archived orders"
                  trailing={
                    query ? (
                      <button
                        type="button"
                        onClick={() => setQuery('')}
                        aria-label="Clear search"
                        className="rounded p-0.5 text-text-3 hover:text-text"
                      >
                        <X size={13} />
                      </button>
                    ) : undefined
                  }
                />
              </div>
            </div>

            {!term ? (
              // Nothing searched for yet. The archive is reached by name, not
              // browsed, so this asks rather than listing something arbitrary.
              <div className="rounded-lg border border-dashed border-border bg-surface/40 px-4 py-6 text-center">
                <Search size={18} className="mx-auto mb-2 text-text-3" aria-hidden />
                <p className="text-sm text-text-2">
                  {(policy?.archived_total ?? 0) === 0
                    ? 'Nothing has been archived yet.'
                    : 'Search to pull an order back out.'}
                </p>
                <p className="mx-auto mt-1 max-w-[36ch] text-[11px] leading-relaxed text-text-3">
                  {(policy?.archived_total ?? 0) === 0
                    ? 'Finished orders land here once they pass the age above.'
                    : 'By order number, item number or description, or a lot number from one of its receipts.'}
                </p>
              </div>
            ) : listLoading && archived.length === 0 ? (
              <Skeleton className="h-24 w-full rounded-lg" />
            ) : archived.length === 0 ? (
              <div className="rounded-lg border border-border bg-bg-elev">
                <EmptyState
                  icon={Archive}
                  title="No archived order matches"
                  hint={`Nothing in the archive matches “${term}”. Check the order number, or try an item or lot.`}
                />
              </div>
            ) : (
              <ul className="space-y-2">
                {archived.map((o) => (
                  <li
                    key={o.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-bg-elev px-3 py-2.5"
                  >
                    <span className="font-mono text-sm text-text">{o.po_reference}</span>
                    <Badge tone="neutral">{ORDER_STATUS_LABEL[o.status]}</Badge>
                    <span className="text-[11px] text-text-3">
                      archived {formatDate(o.archived_at ?? null)}
                    </span>
                    <span className="text-[11px] text-text-3">
                      {o.lines.length} line{o.lines.length === 1 ? '' : 's'} ·{' '}
                      {o.total_received_qty}/{o.total_ordered_qty} units
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      {/* View before you restore — the lines and receipts are
                          usually what tells you whether this is the right
                          order, and restoring to find out is the wrong way
                          round. */}
                      <Button
                        className="h-7 px-2.5 text-xs"
                        onClick={() => onView(o)}
                        title={`Open ${o.po_reference}`}
                      >
                        <Eye size={13} /> View
                      </Button>
                      <Button
                        className="h-7 px-2.5 text-xs"
                        disabled={restoringId === o.id}
                        onClick={() => void restore(o)}
                        title={`Put ${o.po_reference} back on the working list`}
                      >
                        {restoringId === o.id ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <RotateCcw size={13} />
                        )}{' '}
                        Restore
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {term && matches > archived.length && (
              <p className="text-[11px] text-text-3">
                Showing {archived.length} of {matches} matches — narrow the search to
                find the one you want.
              </p>
            )}
          </section>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
