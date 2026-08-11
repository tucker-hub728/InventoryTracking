'use client';

import * as React from 'react';
import { Pencil, Search } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import {
  TableRowsSkeleton,
  type SkeletonColumn,
} from '@/components/shared/table-rows-skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberedPagination } from '@/components/ui/numbered-pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useMinDuration } from '@/hooks/use-min-duration';
import { clampInt, useUrlSearchBox, useUrlState } from '@/hooks/use-url-state';
import { ApiError } from '@/lib/api/client';
import { roleLabel, usersApi, type ApiUser } from '@/lib/api/users';

import { EditUserDialog } from './edit-user-dialog';
import { useUsersShell } from './users-shell';

const PANEL = 'overflow-hidden rounded-lg border border-border bg-bg-elev';

// Module-level so the reference is stable across renders — ``useUrlState``
// reads it through a ref and treats it as constant.
const DEFAULTS = { page: 1, size: 10, q: '' };

/** The endpoint's ``limit`` ceiling — anything larger is a 422. */
const MAX_PAGE_SIZE = 200;

/** Widths chosen to match the real cells: email is the long one, the Actions
 *  column is a right-aligned button. Sliced to 3 when the viewer can't edit. */
const SKELETON_COLUMNS: readonly SkeletonColumn[] = [
  { width: 'w-52' },
  { width: 'w-32' },
  { width: 'w-20' },
  { width: 'w-16', align: 'right' },
];

interface Props {
  /** true = Active Members, false = Inactive Members. */
  isActive: boolean;
  emptyTitle: string;
  emptyHint: string;
}

/**
 * One page of the user directory, filtered to the active or inactive side.
 *
 * Paged end to end: ``page``, ``size`` and ``q`` live in the query string and
 * are sent to ``GET /v1/users`` as ``limit`` / ``offset`` / ``q``, so the
 * browser only ever holds the rows it is showing. The directory is ~400 rows
 * on dev alone; loading all of them to slice ten was never going to scale, and
 * it meant "page 3" was a fact the URL couldn't express.
 */
export function UsersDirectory({ isActive, emptyTitle, emptyHint }: Props) {
  const { canManage } = useUsersShell();
  const { value: raw, set } = useUrlState(DEFAULTS);
  // Query params are hand-editable; clamp before they reach the API so a
  // fat-fingered ``?size=99999`` shows page one rather than a 422.
  const urlState = React.useMemo(
    () => ({
      q: raw.q,
      page: clampInt(raw.page, 1, 100_000, DEFAULTS.page),
      size: clampInt(raw.size, 1, MAX_PAGE_SIZE, DEFAULTS.size),
    }),
    [raw],
  );
  const { page, size } = urlState;

  const [rows, setRows] = React.useState<ApiUser[]>([]);
  const [total, setTotal] = React.useState(0);
  const [superAdminCount, setSuperAdminCount] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [editUser, setEditUser] = React.useState<ApiUser | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  // Bumped after a save so the page is re-read from the server. A save can
  // move a member to the *other* tab (deactivating them), which no local
  // mutation of the current page could represent honestly.
  const [reload, setReload] = React.useState(0);

  const [draftQuery, setDraftQuery] = useUrlSearchBox(urlState.q, (next) =>
    // Any change to the filter invalidates the page index: page 4 of an
    // unfiltered directory is usually past the end of a filtered one.
    set({ q: next, page: 1 }),
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    usersApi
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
        setSuperAdminCount(resp.active_super_admin_count);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load users.');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [isActive, urlState.q, page, size, reload]);

  // Held briefly so a fast local fetch doesn't flash the skeleton for two
  // frames. Shown on *every* fetch, not just the first: changing page or
  // searching replaces every row, so "nothing is happening" would be a lie.
  const showSkeleton = useMinDuration(loading);

  const pageCount = Math.max(1, Math.ceil(total / size));

  // A deep page can outlive the result set it was valid for — deactivate the
  // last member on page 3 and page 3 no longer exists. Walk back rather than
  // showing an empty table under a pager that says there are rows.
  React.useEffect(() => {
    if (!loading && page > pageCount) set({ page: pageCount });
  }, [loading, page, pageCount, set]);

  const openEdit = (user: ApiUser) => {
    setEditUser(user);
    setEditOpen(true);
  };

  return (
    <>
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
            aria-label="Search members"
          />
        </div>
      </div>

      <div className={PANEL}>
        {error ? (
          <EmptyState
            title="Couldn't load users"
            hint={error}
            action={<Button onClick={() => setReload((n) => n + 1)}>Retry</Button>}
          />
        ) : !showSkeleton && rows.length === 0 ? (
          <EmptyState
            title={urlState.q ? 'No members match that search' : emptyTitle}
            hint={urlState.q ? 'Try a different name or email.' : emptyHint}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                {canManage && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {showSkeleton ? (
                <TableRowsSkeleton
                  columns={canManage ? SKELETON_COLUMNS : SKELETON_COLUMNS.slice(0, 3)}
                  rows={Math.min(size, 8)}
                  label="Loading members…"
                />
              ) : (
                rows.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>{u.full_name || '—'}</TableCell>
                    <TableCell>{roleLabel(u.role)}</TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <Button type="button" size="sm" onClick={() => openEdit(u)}>
                          <Pencil size={13} />
                          <span className="ml-1.5">Edit</span>
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {total > 0 && (
        <NumberedPagination
          page={Math.min(page, pageCount)}
          pageCount={pageCount}
          pageSize={size}
          total={total}
          startIdx={(Math.min(page, pageCount) - 1) * size}
          rowsOnPage={rows.length}
          onPageChange={(next) => set({ page: next })}
          // Changing rows-per-page moves the row you were looking at, so
          // there's no honest page to stay on — go back to the first.
          onPageSizeChange={(next) => set({ size: next, page: 1 })}
          noun="member"
        />
      )}

      <EditUserDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        user={editUser}
        onSaved={() => setReload((n) => n + 1)}
        isLastActiveSuperAdmin={
          editUser?.role === 'super_admin' && editUser.is_active && superAdminCount <= 1
        }
      />
    </>
  );
}
