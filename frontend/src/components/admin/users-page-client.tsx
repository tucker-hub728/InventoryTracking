'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import { usersApi, type ApiUser, type RoleId } from '@/lib/api/users';

const ROLE_OPTIONS: { value: RoleId; label: string }[] = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'admin', label: 'Admin' },
  { value: 'operator', label: 'Operator' },
];

const roleLabel = (role: string) =>
  ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role;

export function UsersPageClient() {
  const canEdit = usePermission('users', 'edit');

  const [users, setUsers] = React.useState<ApiUser[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [savingId, setSavingId] = React.useState<string | null>(null);

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

  const changeRole = async (user: ApiUser, role: RoleId) => {
    if (role === user.role) return;
    setSavingId(user.id);
    try {
      const updated = await usersApi.update(user.id, { role });
      setUsers((list) => list.map((u) => (u.id === user.id ? { ...u, ...updated } : u)));
      toast.success(`${user.email} is now ${roleLabel(role)}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to change role.');
      void load();
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader title="Users" subtitle="Accounts and roles." />

      <div className="flex-1 px-6 py-6 sm:px-8">
        <div className="overflow-hidden rounded-lg border border-border bg-bg-elev">
          {error ? (
            <EmptyState title="Couldn't load users" hint={error} />
          ) : loading ? (
            <div className="px-5 py-16 text-center text-sm text-text-3">Loading…</div>
          ) : users.length === 0 ? (
            <EmptyState title="No users" hint="Seed users to get started." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>{u.full_name ?? '—'}</TableCell>
                    <TableCell>
                      {canEdit ? (
                        <div className="w-40">
                          <Select
                            value={u.role}
                            onValueChange={(v) => void changeRole(u, v as RoleId)}
                            disabled={savingId === u.id}
                          >
                            <SelectTrigger aria-label={`Role for ${u.email}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ROLE_OPTIONS.map((r) => (
                                <SelectItem key={r.value} value={r.value}>
                                  {r.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : (
                        <span className="text-text-2">{roleLabel(u.role)}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge tone={u.is_active ? 'success' : 'neutral'} dot>
                        {u.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}
