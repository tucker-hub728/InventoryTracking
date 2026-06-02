'use client';

import * as React from 'react';
import { Download, Plus, Search } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UsersTable } from './users-table';
import { UserSheet } from './user-sheet';
import { InviteUserDialog } from './invite-user-dialog';
import { RolesMatrix } from './roles-matrix';
import { AuditLog } from './audit-log';
import { mockData } from '@/lib/mock-data';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermission } from '@/hooks/use-permission';
import { toast } from '@/components/ui/sonner';
import type { User } from '@/types/auth';

export function UsersPageClient() {
  const users = mockData.users;
  const roles = mockData.roles;
  const canCreate = usePermission('users', 'create');
  const canViewAudit = usePermission('audit', 'view');

  const [query, setQuery] = React.useState('');
  const [filterRole, setFilterRole] = React.useState('all');
  const [filterStatus, setFilterStatus] = React.useState('all');
  const [editing, setEditing] = React.useState<User | null>(null);
  const [inviting, setInviting] = React.useState(false);

  const debounced = useDebouncedValue(query, 150);

  const filtered = React.useMemo(() => {
    const q = debounced.trim().toLowerCase();
    return users.filter((u) => {
      if (filterRole !== 'all' && u.role !== filterRole) return false;
      if (filterStatus !== 'all' && u.status !== filterStatus) return false;
      if (q && !u.name.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [users, debounced, filterRole, filterStatus]);

  return (
    <>
      <PageHeader
        title="Users & Roles"
        subtitle="Manage who can access the system and what they can do."
        actions={
          <>
            <Button onClick={() => toast.info('Export queued')}>
              <Download size={14} /> Export
            </Button>
            {canCreate && (
              <Button variant="primary" onClick={() => setInviting(true)}>
                <Plus size={14} /> Invite user
              </Button>
            )}
          </>
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Tabs defaultValue="users">
          <TabsList>
            <TabsTrigger value="users">Users</TabsTrigger>
            {/* <TabsTrigger value="roles">Roles & permissions</TabsTrigger>
            {canViewAudit && <TabsTrigger value="audit">Audit log</TabsTrigger>} */}
          </TabsList>

          <TabsContent value="users" className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                icon={Search}
                placeholder="Search by name or email"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                wrapperClassName="w-[280px]"
                aria-label="Search users"
              />
              <Select value={filterRole} onValueChange={setFilterRole}>
                <SelectTrigger className="w-[160px]" aria-label="Filter by role">
                  <SelectValue placeholder="All roles" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-[150px]" aria-label="Filter by status">
                  <SelectValue placeholder="Any status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any status</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="invited">Invited</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                </SelectContent>
              </Select>
              <div className="ml-auto text-xs text-text-3">
                {filtered.length} of {users.length}
              </div>
            </div>
            <Card className="overflow-hidden p-0">
              <div className="overflow-x-auto">
                <UsersTable users={filtered} roles={roles} onEdit={setEditing} />
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="roles">
            <RolesMatrix roles={roles} />
          </TabsContent>

          {canViewAudit && (
            <TabsContent value="audit">
              <AuditLog />
            </TabsContent>
          )}
        </Tabs>
      </div>

      <UserSheet
        open={Boolean(editing)}
        onOpenChange={(o) => !o && setEditing(null)}
        user={editing}
        roles={roles}
      />
      <InviteUserDialog open={inviting} onOpenChange={setInviting} roles={roles} />
    </>
  );
}
