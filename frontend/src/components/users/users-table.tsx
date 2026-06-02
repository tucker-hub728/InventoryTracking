'use client';

import * as React from 'react';
import { MoreHorizontal } from 'lucide-react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { cn, getInitials } from '@/lib/utils';
import type { Role, User } from '@/types/auth';

const STATUS_TONE = {
  active: 'success',
  invited: 'accent',
  suspended: 'danger',
} as const;

interface Props {
  users: User[];
  roles: Role[];
  onEdit: (user: User) => void;
}

export function UsersTable({ users, roles, onEdit }: Props) {
  if (users.length === 0) {
    return <EmptyState title="No users match" hint="Adjust filters or invite a new user." />;
  }
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead className="w-[180px]">Role</TableHead>
          <TableHead className="w-[140px]">Status</TableHead>
          <TableHead className="w-[160px]">Last active</TableHead>
          <TableHead className="w-[48px]" aria-label="Actions" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((u) => (
          <TableRow key={u.id} interactive onClick={() => onEdit(u)}>
            <TableCell>
              <div className="flex items-center gap-2.5">
                <Avatar
                  className={cn(
                    'size-7 text-[11px]',
                    u.status === 'invited' &&
                      'border border-dashed border-border-strong bg-surface-2 text-text-3',
                  )}
                >
                  <AvatarFallback>{getInitials(u.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{u.name}</div>
                  <div className="truncate text-xs text-text-3">{u.email}</div>
                </div>
              </div>
            </TableCell>
            <TableCell className="text-sm">{roleName(u.role)}</TableCell>
            <TableCell>
              <Badge tone={STATUS_TONE[u.status]} dot>
                {u.status.charAt(0).toUpperCase() + u.status.slice(1)}
              </Badge>
            </TableCell>
            <TableCell className="text-xs text-text-2">{u.lastActive}</TableCell>
            <TableCell>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="More actions"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(u);
                }}
              >
                <MoreHorizontal size={15} />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
