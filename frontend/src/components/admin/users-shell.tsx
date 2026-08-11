'use client';

import * as React from 'react';
import { UserPlus } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { RouteTabs, type RouteTab } from '@/components/shared/route-tabs';
import { Button } from '@/components/ui/button';
import { selectIsSuperAdmin, useAuthStore } from '@/stores/auth.store';

import { InviteUserDialog } from './invite-user-dialog';

export const USERS_TABS: readonly RouteTab[] = [
  { href: '/users/active', label: 'Active Members' },
  { href: '/users/inactive', label: 'Inactive Members' },
  { href: '/users/invitations', label: 'Invitations' },
];

interface UsersShellContext {
  /** Super-admin: may invite, edit, resend and revoke. */
  canManage: boolean;
  /** Bumped when a new invite is created, so the Invitations tab reloads. */
  inviteReload: number;
}

const Ctx = React.createContext<UsersShellContext>({
  canManage: false,
  inviteReload: 0,
});

export const useUsersShell = (): UsersShellContext => React.useContext(Ctx);

/**
 * Chrome shared by the three Users tabs, which are now three routes
 * (``/users/active``, ``/users/inactive``, ``/users/invitations``) rather than
 * three Radix tab panels. Rendered from ``app/(app)/users/layout.tsx`` so it
 * survives navigation between them — the header doesn't remount and the tab
 * strip doesn't flicker.
 *
 * The invite dialog lives here because the button that opens it is in the
 * header, but the list it affects is in a child route. ``inviteReload`` is
 * passed down through context rather than a prop for exactly that reason: the
 * two components no longer share a parent that can hold the state as a prop.
 */
export function UsersShell({ children }: { children: React.ReactNode }) {
  // Member management is super-admin-only. ``super_admin`` and ``admin``
  // collapse into the same client-side RBAC bucket, so the permission matrix
  // can't tell them apart — gate on the real backend role.
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteReload, setInviteReload] = React.useState(0);

  const ctx = React.useMemo(
    () => ({ canManage: isSuperAdmin, inviteReload }),
    [isSuperAdmin, inviteReload],
  );

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Users"
        subtitle="Accounts, roles and invitations."
        actions={
          isSuperAdmin ? (
            <Button type="button" variant="primary" onClick={() => setInviteOpen(true)}>
              <UserPlus size={15} />
              <span className="ml-1.5">Invite user</span>
            </Button>
          ) : undefined
        }
        tabs={<RouteTabs tabs={USERS_TABS} label="User directory" />}
      />

      <div className="flex-1 px-6 py-6 sm:px-8">
        <Ctx.Provider value={ctx}>{children}</Ctx.Provider>
      </div>

      {isSuperAdmin && (
        <InviteUserDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          onInvited={() => setInviteReload((n) => n + 1)}
        />
      )}
    </div>
  );
}
