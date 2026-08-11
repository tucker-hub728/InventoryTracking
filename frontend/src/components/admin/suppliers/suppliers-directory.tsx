'use client';

import * as React from 'react';
import { Plus, Search } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NumberedPagination } from '@/components/ui/numbered-pagination';
import { toast } from '@/components/ui/sonner';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMinDuration } from '@/hooks/use-min-duration';
import { clampInt, useUrlSearchBox, useUrlState } from '@/hooks/use-url-state';
import { ApiError } from '@/lib/api/client';
import { suppliersApi, type Supplier } from '@/lib/api/suppliers';

import { SupplierEditDialog } from './supplier-edit-dialog';
import { SuppliersTable } from './suppliers-table';
import { useSuppliersShell } from './suppliers-shell';

// Stable reference — see ``useUrlState``.
const DEFAULTS = { page: 1, size: 25, q: '' };

/** The endpoint's ``limit`` ceiling — anything larger is a 422. */
const MAX_PAGE_SIZE = 500;

interface Props {
  /** true = the Active tab, false = the Deactivated tab. */
  isActive: boolean;
}

/**
 * One page of the supplier master, filtered to the active or deactivated side.
 *
 * Paged end to end against ``GET /v1/suppliers``: ``page``, ``size`` and ``q``
 * live in the query string and become ``limit`` / ``offset`` / ``q``. The page
 * previously loaded every supplier and filtered in memory with no pager at all
 * — fine at 72 rows, not a thing to keep once the workbook grows.
 */
export function SuppliersDirectory({ isActive }: Props) {
  const { canManage, createReload, openCreate } = useSuppliersShell();
  const { confirm, confirmDialog } = useConfirm();
  const { value: raw, set } = useUrlState(DEFAULTS);
  // Query params are hand-editable; clamp before they reach the API.
  const urlState = React.useMemo(
    () => ({
      q: raw.q,
      page: clampInt(raw.page, 1, 100_000, DEFAULTS.page),
      size: clampInt(raw.size, 1, MAX_PAGE_SIZE, DEFAULTS.size),
    }),
    [raw],
  );
  const { page, size } = urlState;

  const [rows, setRows] = React.useState<Supplier[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<Supplier | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  // Bumped after a write. Deactivating moves the row to the *other* tab, so
  // there is no correct local edit — only a refetch tells the truth.
  const [reload, setReload] = React.useState(0);

  const [draftQuery, setDraftQuery] = useUrlSearchBox(urlState.q, (next) =>
    set({ q: next, page: 1 }),
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);
    suppliersApi
      .list(
        {
          isActive,
          q: urlState.q || undefined,
          limit: size,
          offset: (page - 1) * size,
        },
        { signal: ctrl.signal },
      )
      .then((resp) => {
        setRows(resp.items);
        setTotal(resp.total);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load suppliers.');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [isActive, urlState.q, page, size, reload, createReload]);

  // Shown on every fetch, not just the first — a page change or a search
  // replaces every row. Held briefly so a fast fetch doesn't flash it.
  const showSkeleton = useMinDuration(loading);

  const pageCount = Math.max(1, Math.ceil(total / size));

  React.useEffect(() => {
    if (!loading && page > pageCount) set({ page: pageCount });
  }, [loading, page, pageCount, set]);

  const handleUpdated = (updated: Supplier): void => {
    toast.success('Supplier updated', { description: updated.name });
    setReload((n) => n + 1);
  };

  // Soft-delete. Server-idempotent, but we always re-read rather than trusting
  // the optimistic shape of the list.
  const handleDeactivate = async (v: Supplier): Promise<void> => {
    if (!canManage) return;
    const ok = await confirm({
      title: `Deactivate ${v.name}?`,
      description:
        'It will be hidden from new item / lot pickers and move to the Deactivated tab. You can reactivate it later.',
      confirmLabel: 'Deactivate',
      destructive: true,
    });
    if (!ok) return;
    setBusyId(v.id);
    try {
      const updated = await suppliersApi.deactivate(v.id);
      toast.success('Supplier deactivated', { description: updated.name });
      setReload((n) => n + 1);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to deactivate supplier.');
    } finally {
      setBusyId(null);
    }
  };

  const handleReactivate = async (v: Supplier): Promise<void> => {
    if (!canManage) return;
    setBusyId(v.id);
    try {
      const updated = await suppliersApi.update(v.id, { is_active: true });
      toast.success('Supplier reactivated', { description: updated.name });
      setReload((n) => n + 1);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to reactivate supplier.');
    } finally {
      setBusyId(null);
    }
  };

  const emptyTitle = isActive ? 'No active suppliers' : 'No deactivated suppliers';
  const emptyHint = isActive
    ? 'The seed migration usually populates this from the workbook. Add one manually.'
    : 'Suppliers you deactivate are kept here rather than deleted, and can be reactivated.';

  return (
    <Card className="p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3"
            aria-hidden
          />
          <Input
            value={draftQuery}
            onChange={(e) => setDraftQuery(e.target.value)}
            placeholder="Search by name or email"
            className="pl-9"
            aria-label="Search suppliers"
          />
        </div>
        <div className="text-xs text-text-3">
          {loading ? 'Loading…' : `${total.toLocaleString()} ${total === 1 ? 'supplier' : 'suppliers'}`}
        </div>
      </div>

      {loadError ? (
        <EmptyState
          title="Couldn't load suppliers"
          hint={loadError}
          action={<Button onClick={() => setReload((n) => n + 1)}>Retry</Button>}
        />
      ) : !showSkeleton && rows.length === 0 ? (
        <EmptyState
          title={urlState.q ? 'No suppliers match that search' : emptyTitle}
          hint={urlState.q ? 'Try a different name or email.' : emptyHint}
          action={
            canManage && isActive && !urlState.q ? (
              <Button variant="primary" onClick={openCreate}>
                <Plus size={14} /> Add supplier
              </Button>
            ) : undefined
          }
        />
      ) : (
        <SuppliersTable
          suppliers={rows}
          loading={showSkeleton}
          onEdit={canManage ? (v) => setEditing(v) : undefined}
          onDeactivate={canManage ? handleDeactivate : undefined}
          onReactivate={canManage ? handleReactivate : undefined}
          busyId={busyId}
        />
      )}

      {total > 0 && (
        <NumberedPagination
          page={Math.min(page, pageCount)}
          pageCount={pageCount}
          pageSize={size}
          total={total}
          startIdx={(Math.min(page, pageCount) - 1) * size}
          rowsOnPage={rows.length}
          onPageChange={(next) => set({ page: next })}
          onPageSizeChange={(next) => set({ size: next, page: 1 })}
          noun="supplier"
        />
      )}

      <SupplierEditDialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        supplier={editing}
        onUpdated={handleUpdated}
      />

      {confirmDialog}
    </Card>
  );
}
