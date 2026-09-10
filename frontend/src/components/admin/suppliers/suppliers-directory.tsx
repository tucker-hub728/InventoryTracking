'use client';

import * as React from 'react';
import { Plus, Search } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
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
import { selectIsSuperAdmin, useAuthStore } from '@/stores/auth.store';

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
  // Deleting is Super-Admin-only (client, 2026-09-10) — narrower than the
  // ``inventory:create`` that covers deactivate, on the CTL-001 rule that the
  // route which cannot be undone gets the tighter gate. The server enforces it;
  // this only decides whether to draw the button.
  //
  // ``selectIsSuperAdmin`` reads ``rawRole``, not ``user.role`` — the latter is
  // the RBAC bucket, where super_admin and admin are both ``admin``.
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);
  const [deleting, setDeleting] = React.useState<Supplier | null>(null);
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

  // Step two. The confirm is deliberately blunt about what is irreversible —
  // the row survives in the database, but nothing in the app can bring it back.
  const handleDelete = async (v: Supplier): Promise<void> => {
    if (!isSuperAdmin) return;
    const ok = await confirm({
      title: `Delete ${v.name}?`,
      description:
        'It will be removed from every screen, including this tab, and its name ' +
        'becomes available again. This cannot be undone from the app. Suppliers ' +
        'attached to items, lots or orders cannot be deleted.',
      confirmLabel: 'Continue',
      destructive: true,
    });
    if (!ok) return;
    setDeleting(v);
  };

  const submitDelete = async (evidenceId: string): Promise<void> => {
    const target = deleting;
    if (!target) return;
    setBusyId(target.id);
    try {
      await suppliersApi.remove(target.id, evidenceId);
      toast.success('Supplier deleted', { description: target.name });
      setReload((n) => n + 1);
    } catch (err) {
      // The server names what is still holding it (items / lots / order lines),
      // so surface its message rather than a generic failure.
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete supplier.');
    } finally {
      setBusyId(null);
      setDeleting(null);
    }
  };

  const emptyTitle = isActive ? 'No active suppliers' : 'No deactivated suppliers';
  const emptyHint = isActive
    ? 'The seed migration usually populates this from the workbook. Add one manually.'
    : 'Suppliers you deactivate are kept here and can be reactivated. A Super Admin ' +
      'can delete one that nothing is attached to, which removes it from every screen.';

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
          onDelete={!isActive && isSuperAdmin ? handleDelete : undefined}
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

      <PasswordReauthDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        action="supplier.delete"
        // Bound to the supplier itself (VR-006 / esignbind01): it is both the
        // record on screen and the record being changed, so the server can
        // assert the ticket against a real subject instead of the action alone.
        recordTable="meta.suppliers"
        recordId={deleting?.id}
        title="Sign to delete"
        meaning={
          deleting
            ? `I am deleting the supplier ${deleting.name}. It will no longer appear ` +
              `anywhere in the application and its name becomes available for re-use. ` +
              `The record is retained for audit.`
            : ''
        }
        onConfirmed={(evidence) => void submitDelete(evidence.evidence_id)}
      />

      {confirmDialog}
    </Card>
  );
}
