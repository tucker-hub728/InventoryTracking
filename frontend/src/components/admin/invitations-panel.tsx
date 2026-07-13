'use client';

import * as React from 'react';
import { RotateCw, Ban } from 'lucide-react';
import { toast } from '@/components/ui/sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Pagination, usePagination } from '@/components/ui/pagination';
import type { BadgeTone } from '@/types/ui';
import { ApiError } from '@/lib/api/client';
import {
  acceptUrlFor,
  invitationsApi,
  type Invitation,
  type InviteStatus,
} from '@/lib/api/invitations';
import { CopyableLink } from './copyable-link';

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

interface Props {
  /** Super-admin: may resend / revoke. Others see a read-only list. */
  canManage: boolean;
  /** Bump to force a reload (e.g. after a new invite is created). */
  reloadSignal: number;
}

export function InvitationsPanel({ canManage, reloadSignal }: Props) {
  const { confirm, confirmDialog } = useConfirm();
  const [invites, setInvites] = React.useState<Invitation[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState<{ email: string; link: string } | null>(null);
  const pg = usePagination(invites, 10);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      // Only pending invitations belong here — accepted users appear under
      // Active Members, and revoked ones are hard-deleted.
      setInvites(await invitationsApi.list({ status: 'pending', signal }));
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setError(err instanceof ApiError ? err.message : 'Failed to load invitations.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load, reloadSignal]);

  const resend = async (invite: Invitation) => {
    setBusyId(invite.id);
    try {
      const result = await invitationsApi.resend(invite.id);
      setRevealed({ email: result.email, link: acceptUrlFor(result) });
      toast.success(`A fresh invitation was sent to ${result.email}.`);
      await load();
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
      // Revoke hard-deletes the invitation, so drop it from the list.
      setInvites((list) => list.filter((i) => i.id !== invite.id));
      toast.success(`Invitation for ${invite.email} revoked`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to revoke invitation.');
      void load();
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <div className="px-5 py-10 text-center text-sm text-text-3">Loading invitations…</div>;
  }
  if (error) {
    return <div className="px-5 py-10 text-center text-sm text-danger">{error}</div>;
  }
  if (invites.length === 0) {
    return <div className="px-5 py-10 text-center text-sm text-text-3">No invitations yet.</div>;
  }

  return (
    <>
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
          {pg.pageItems.map((inv) => {
            const name = `${inv.first_name} ${inv.last_name}`.trim();
            // Resend applies to anything not already accepted; revoke only to a
            // live pending invite.
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
          })}
        </TableBody>
      </Table>
      <Pagination
        page={pg.page}
        pageCount={pg.pageCount}
        total={pg.total}
        rangeStart={pg.rangeStart}
        rangeEnd={pg.rangeEnd}
        onPageChange={pg.setPage}
        noun="invitation"
      />

      {/* Fresh link reveal after a resend. */}
      <Dialog open={revealed !== null} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New link ready</DialogTitle>
            <DialogDescription>
              A fresh invitation email was sent to{' '}
              <strong className="text-text">{revealed?.email}</strong>. You can also share the new
              one-time link below. The previous link no longer works.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-1.5">
              <Label htmlFor="resend-link">Accept link</Label>
              {revealed && <CopyableLink id="resend-link" value={revealed.link} />}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="primary" onClick={() => setRevealed(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {confirmDialog}
    </>
  );
}
