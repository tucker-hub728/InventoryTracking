'use client';

import * as React from 'react';
import { Pencil, UserPlus } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsScroller, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination, usePagination } from '@/components/ui/pagination';
import { selectIsSuperAdmin, useAuthStore } from '@/stores/auth.store';
import { ApiError } from '@/lib/api/client';
import { usersApi, roleLabel, type ApiUser } from '@/lib/api/users';
import { EditUserDialog } from './edit-user-dialog';
import { InviteUserDialog } from './invite-user-dialog';
import { InvitationsPanel } from './invitations-panel';

const PANEL = 'overflow-hidden rounded-lg border border-border bg-bg-elev';

interface UsersTableProps {
  users: ApiUser[];
  loading: boolean;
  error: string | null;
  canEdit: boolean;
  onEdit: (user: ApiUser) => void;
  emptyTitle: string;
  emptyHint: string;
}

function UsersTable({
  users,
  loading,
  error,
  canEdit,
  onEdit,
  emptyTitle,
  emptyHint,
}: UsersTableProps) {
  const pg = usePagination(users, 10);

  if (error) return <EmptyState title="Couldn't load users" hint={error} />;
  if (loading) {
    return <div className="px-5 py-16 text-center text-sm text-text-3">Loading…</div>;
  }
  if (users.length === 0) return <EmptyState title={emptyTitle} hint={emptyHint} />;

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
            {canEdit && <TableHead className="text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {pg.pageItems.map((u) => (
            <TableRow key={u.id}>
              <TableCell>{u.email}</TableCell>
              <TableCell>{u.full_name || '—'}</TableCell>
              <TableCell>{roleLabel(u.role)}</TableCell>
              {canEdit && (
                <TableCell className="text-right">
                  <Button type="button" size="sm" onClick={() => onEdit(u)}>
                    <Pencil size={13} />
                    <span className="ml-1.5">Edit</span>
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Pagination
        page={pg.page}
        pageCount={pg.pageCount}
        total={pg.total}
        rangeStart={pg.rangeStart}
        rangeEnd={pg.rangeEnd}
        onPageChange={pg.setPage}
        noun="member"
      />
    </>
  );
}

export function UsersPageClient() {
  // Member management (inviting and editing) is super-admin-only. ``super_admin``
  // and ``admin`` collapse into the same client-side RBAC bucket, so the
  // permission matrix can't tell them apart — gate on the real backend role.
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);
  const canEdit = isSuperAdmin;
  const canInvite = isSuperAdmin;

  const [users, setUsers] = React.useState<ApiUser[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [editUser, setEditUser] = React.useState<ApiUser | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  // Bumped whenever a new invite is created so the invitations panel reloads.
  const [inviteReload, setInviteReload] = React.useState(0);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await usersApi.list({ signal }));
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setError(err instanceof ApiError ? err.message : 'Failed to load users.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Super admins are listed alongside everyone else: since REQ-2026-07-31-ROL-005
  // they are made by promotion, so a super admin has to be able to see who holds
  // the role and demote one who shouldn't. (They used to be filtered out here,
  // back when the role was a fixed singleton set at seed time — that would have
  // made a freshly promoted user vanish from the directory.)
  const activeUsers = React.useMemo(() => users.filter((u) => u.is_active), [users]);
  const inactiveUsers = React.useMemo(() => users.filter((u) => !u.is_active), [users]);

  // Mirrors the backend's `count_super_admins`: active ones only, since a
  // suspended super admin can't log in and so can't hold the install open.
  const activeSuperAdminCount = React.useMemo(
    () => users.filter((u) => u.is_active && u.role === 'super_admin').length,
    [users],
  );

  const openEdit = (u: ApiUser) => {
    setEditUser(u);
    setEditOpen(true);
  };

  const onSaved = (updated: ApiUser) =>
    setUsers((list) => list.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)));

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Users"
        subtitle="Accounts, roles and invitations."
        actions={
          canInvite ? (
            <Button type="button" variant="primary" onClick={() => setInviteOpen(true)}>
              <UserPlus size={15} />
              <span className="ml-1.5">Invite user</span>
            </Button>
          ) : undefined
        }
      />

      <div className="flex-1 px-6 py-6 sm:px-8">
        <Tabs defaultValue="members">
          <TabsScroller>
            <TabsList>
              <TabsTrigger value="members">Active Members</TabsTrigger>
              <TabsTrigger value="inactive">Inactive Members</TabsTrigger>
              <TabsTrigger value="invitations">Invitations</TabsTrigger>
            </TabsList>
          </TabsScroller>

          <TabsContent value="members">
            <div className={PANEL}>
              <UsersTable
                users={activeUsers}
                loading={loading}
                error={error}
                canEdit={canEdit}
                onEdit={openEdit}
                emptyTitle="No active members"
                emptyHint="Invite a user to get started."
              />
            </div>
          </TabsContent>

          <TabsContent value="inactive">
            <div className={PANEL}>
              <UsersTable
                users={inactiveUsers}
                loading={loading}
                error={error}
                canEdit={canEdit}
                onEdit={openEdit}
                emptyTitle="No inactive members"
                emptyHint="Deactivated users appear here."
              />
            </div>
          </TabsContent>

          <TabsContent value="invitations">
            <div className={PANEL}>
              <InvitationsPanel canManage={canInvite} reloadSignal={inviteReload} />
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <EditUserDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        user={editUser}
        onSaved={onSaved}
        isLastActiveSuperAdmin={
          editUser?.role === 'super_admin' && editUser.is_active && activeSuperAdminCount <= 1
        }
      />

      {canInvite && (
        <InviteUserDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          onInvited={() => setInviteReload((n) => n + 1)}
        />
      )}
    </div>
  );
}
