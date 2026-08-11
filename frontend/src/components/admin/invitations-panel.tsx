'use client';

import * as React from 'react';
import { Ban, RotateCw, Search } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import {
  TableRowsSkeleton,
  type SkeletonColumn,
} from '@/components/shared/table-rows-skeleton';
import { Badge } from '@/components/ui/badge';
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
import { toast } from '@/components/ui/sonner';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMinDuration } from '@/hooks/use-min-duration';
import { clampInt, useUrlSearchBox, useUrlState } from '@/hooks/use-url-state';
import type { BadgeTone } from '@/types/ui';
import { ApiError } from '@/lib/api/client';
import { invitationsApi, type Invitation, type InviteStatus } from '@/lib/api/invitations';

import { useUsersShell } from './users-shell';

const PANEL = 'overflow-hidden rounded-lg border border-border bg-bg-elev';

// Stable reference — see ``useUrlState``.
const DEFAULTS = { page: 1, size: 10, q: '' };

/** The endpoint's ``limit`` ceiling — anything larger is a 422. */
const MAX_PAGE_SIZE = 200;

/** Matches the real cells: Status is a badge, Actions two right-aligned
 *  buttons. Sliced to 5 when the viewer can't manage invites. */
const SKELETON_COLUMNS: readonly SkeletonColumn[] = [
  { width: 'w-52' },
  { width: 'w-32' },
  { width: 'w-20' },
  { width: 'w-24', pill: true },
  { width: 'w-24' },
  { width: 'w-36', align: 'right' },
];

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  operator: 'Operator',
  read_only: 'Read-Only',
};

const STATUS_TONE: Record<InviteStatus, BadgeTone> = {
  pending: 'accent',
  accepted: 'success',
  revoked: 'neutral',
  expired: 'warning',
};

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * The Invitations tab, paged end to end against ``GET /v1/invitations``.
 *
 * Only pending invitations are listed: accepted ones appear under Active
 * Members, and revoked ones are hard-deleted. An expired invite is still
 * *stored* as pending, so it stays visible here — which is deliberate, since
 * an expired invite is the one you most want to resend.
 */
export function InvitationsPanel() {
  const { canManage, inviteReload } = useUsersShell();
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

  const [rows, setRows] = React.useState<Invitation[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);

  const [draftQuery, setDraftQuery] = useUrlSearchBox(urlState.q, (next) =>
    set({ q: next, page: 1 }),
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    invitationsApi
      .list(
        {
          status: 'pending',
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
        setError(err instanceof ApiError ? err.message : 'Failed to load invitations.');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [urlState.q, page, size, reload, inviteReload]);

  // Shown on every fetch, not just the first — a page change or a search
  // replaces every row. Held briefly so a fast fetch doesn't flash it.
  const showSkeleton = useMinDuration(loading);

  const pageCount = Math.max(1, Math.ceil(total / size));

  React.useEffect(() => {
    if (!loading && page > pageCount) set({ page: pageCount });
  }, [loading, page, pageCount, set]);

  const resend = async (invite: Invitation) => {
    setBusyId(invite.id);
    try {
      const result = await invitationsApi.resend(invite.id);
      // Cognito emails the fresh temporary password directly; nothing to reveal here.
      toast.success(`A fresh temporary password was sent to ${result.email}.`);
      setReload((n) => n + 1);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to resend invitation.');
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (invite: Invitation) => {
    const ok = await confirm({
      title: 'Revoke invitation?',
      description: `This deletes ${invite.email}'s reserved account and their invite. You can invite them again later.`,
      confirmLabel: 'Revoke',
      destructive: true,
    });
    if (!ok) return;
    setBusyId(invite.id);
    try {
      await invitationsApi.revoke(invite.id);
      toast.success(`Invitation for ${invite.email} revoked`);
      // Refetch rather than splicing the row out: the row that backfills this
      // page comes from the server, and ``total`` has to move with it.
      setReload((n) => n + 1);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to revoke invitation.');
      setReload((n) => n + 1);
    } finally {
      setBusyId(null);
    }
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
            aria-label="Search invitations"
          />
        </div>
      </div>

      <div className={PANEL}>
        {error ? (
          <EmptyState
            title="Couldn't load invitations"
            hint={error}
            action={<Button onClick={() => setReload((n) => n + 1)}>Retry</Button>}
          />
        ) : !showSkeleton && rows.length === 0 ? (
          <EmptyState
            title={urlState.q ? 'No invitations match that search' : 'No invitations yet'}
            hint={
              urlState.q
                ? 'Try a different name or email.'
                : 'Invite a user and their pending invitation appears here.'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expires</TableHead>
                {canManage && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {showSkeleton ? (
                <TableRowsSkeleton
                  columns={canManage ? SKELETON_COLUMNS : SKELETON_COLUMNS.slice(0, 5)}
                  rows={Math.min(size, 8)}
                  label="Loading invitations…"
                />
              ) : (
                rows.map((inv) => {
                const name = `${inv.first_name} ${inv.last_name}`.trim();
                // Resend applies to anything not already accepted; revoke only
                // to a live pending invite.
                const canResend = canManage && inv.status !== 'accepted';
                const canRevoke = canManage && inv.status === 'pending';
                return (
                  <TableRow key={inv.id}>
                    <TableCell>{inv.email}</TableCell>
                    <TableCell>{name || '—'}</TableCell>
                    <TableCell>{ROLE_LABEL[inv.role] ?? inv.role}</TableCell>
                    <TableCell>
                      <Badge tone={STATUS_TONE[inv.status]} dot>
                        {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-text-2">{fmtDate(inv.expires_at)}</TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {canResend && (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void resend(inv)}
                              disabled={busyId === inv.id}
                            >
                              <RotateCw size={13} />
                              <span className="ml-1.5">Resend</span>
                            </Button>
                          )}
                          {canRevoke && (
                            <Button
                              type="button"
                              size="sm"
                              variant="danger"
                              onClick={() => void revoke(inv)}
                              disabled={busyId === inv.id}
                            >
                              <Ban size={13} />
                              <span className="ml-1.5">Revoke</span>
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
                })
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
          onPageSizeChange={(next) => set({ size: next, page: 1 })}
          noun="invitation"
        />
      )}

      {confirmDialog}
    </>
  );
}
