'use client';

import * as React from 'react';
import { toast } from '@/components/ui/sonner';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { ApiError } from '@/lib/api/client';
import { usersApi, roleLabel, type ApiUser, type GrantableRole, type UserUpdateInput } from '@/lib/api/users';

const ROLE_OPTIONS: { value: GrantableRole; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'operator', label: 'Operator' },
  { value: 'read_only', label: 'Read-Only' },
];

// Super Admin is offered only by promotion, and only to someone who has accepted
// their invite and logged in (REQ-2026-07-31-ROL-005). It is never in the invite
// dialog's list — that stays `AssignableRole`.
const SUPER_ADMIN_OPTION = { value: 'super_admin' as const, label: 'Super Admin' };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: ApiUser | null;
  onSaved: (updated: ApiUser) => void;
  /** True when this user is the only *active* super admin left. Their role and
   * active flag lock, mirroring the backend's `last_super_admin` guard so the
   * system can't be locked out — including by the current user demoting self. */
  isLastActiveSuperAdmin?: boolean;
}

/** Split a stored display name into first / last, mirroring the invite fields:
 * the first word is the first name, everything after it is the last name. */
function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

export function EditUserDialog({
  open,
  onOpenChange,
  user,
  onSaved,
  isLastActiveSuperAdmin = false,
}: Props) {
  const { confirm, confirmDialog } = useConfirm();
  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<GrantableRole>('read_only');
  const [active, setActive] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  // Seed the form from the selected user each time the dialog opens.
  React.useEffect(() => {
    if (open && user) {
      const { first, last } = splitName(user.full_name);
      setFirstName(first);
      setLastName(last);
      setEmail(user.email);
      setRole((user.role as GrantableRole) ?? 'read_only');
      setActive(user.is_active);
    }
  }, [open, user]);

  if (!user) return null;

  const isSuperAdmin = user.role === 'super_admin';
  // The last active super admin is frozen — demoting or deactivating them would
  // strand the install, and the backend rejects it with `last_super_admin`.
  const locked = isSuperAdmin && isLastActiveSuperAdmin;
  // Promotion is offered only to someone eligible. An existing super admin keeps
  // the option so their current role still renders in the Select.
  const canOfferSuperAdmin = isSuperAdmin || user.can_be_promoted;
  const roleOptions = canOfferSuperAdmin ? [SUPER_ADMIN_OPTION, ...ROLE_OPTIONS] : ROLE_OPTIONS;

  const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
  const nameValid = Boolean(firstName.trim()) && Boolean(lastName.trim());
  const trimmedEmail = email.trim().toLowerCase();
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmedEmail);
  const emailChanged = trimmedEmail !== user.email.toLowerCase();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameValid || !emailValid || saving) return;

    const changes: UserUpdateInput = {};
    if (fullName !== user.full_name) changes.full_name = fullName;
    if (emailChanged) changes.email = trimmedEmail;
    if (!locked) {
      if (role !== user.role) changes.role = role;
      if (active !== user.is_active) changes.is_active = active;
    }

    if (Object.keys(changes).length === 0) {
      onOpenChange(false);
      return;
    }

    // Changing the email moves the sign-in address — the member can no longer
    // sign in with the old one, so make that consequence explicit.
    if (changes.email) {
      const proceed = await confirm({
        title: 'Change sign-in email?',
        description: `${user.email} will become ${changes.email}. They must use the new address to sign in from now on. This is recorded in the audit log.`,
        confirmLabel: 'Change email',
      });
      if (!proceed) return;
    }

    // A role change is consequential — confirm it explicitly. Promotion to super
    // admin gets its own wording, since it hands over full access.
    if (changes.role) {
      const toSuperAdmin = changes.role === 'super_admin';
      const proceed = await confirm({
        title: toSuperAdmin ? 'Promote to Super Admin?' : 'Change role?',
        description: toSuperAdmin
          ? `${user.email} will get full access, including managing members and creating shelves and Cold Storage locations. This is recorded in the audit log.`
          : `${user.email} will become ${roleLabel(changes.role)}. This changes what they can access.`,
        confirmLabel: toSuperAdmin ? 'Promote' : 'Change role',
      });
      if (!proceed) return;
    }

    setSaving(true);
    try {
      const updated = await usersApi.update(user.id, changes);
      onSaved(updated);
      toast.success(`${updated.email} updated`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update user.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Edit user</DialogTitle>
              <DialogDescription>
                {locked
                  ? 'This is the last active super admin — their role and status are locked so the system can’t be locked out. Only the name can be changed.'
                  : 'Update the name, role, and active status.'}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-first">First name</Label>
                  <Input
                    id="edit-first"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Alex"
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-last">Last name</Label>
                  <Input
                    id="edit-last"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Rivera"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-email">Email</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={!emailValid}
                  autoComplete="off"
                />
                {!emailValid ? (
                  <p role="alert" className="text-xs text-danger">
                    Enter a valid email address.
                  </p>
                ) : (
                  emailChanged && (
                    <p className="text-xs text-warning">
                      This is their sign-in address — they’ll need to use the new one.
                    </p>
                  )
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-role">Role</Label>
                {locked ? (
                  <Input id="edit-role" value="Super Admin" disabled readOnly />
                ) : (
                  <Select value={role} onValueChange={(v) => setRole(v as GrantableRole)}>
                    <SelectTrigger id="edit-role" aria-label="Role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roleOptions.map((r) => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {/* Explain a missing Super Admin option rather than silently omitting
                    it — e.g. "Tom has not logged in yet, so they can't be promoted…". */}
                {!locked && !canOfferSuperAdmin && user.promotion_blocked_reason && (
                  <p className="text-xs text-text-3">
                    {user.promotion_blocked_reason}, so they can’t be promoted to Super Admin yet.
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                <div>
                  <Label htmlFor="edit-active" className="cursor-pointer">
                    Active
                  </Label>
                  <p className="text-xs text-text-3">
                    {locked
                      ? 'The last active super admin can’t be deactivated.'
                      : 'Inactive users can’t sign in or use the app (disabled in Cognito).'}
                  </p>
                </div>
                <Switch
                  id="edit-active"
                  checked={active}
                  onCheckedChange={setActive}
                  disabled={locked}
                />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!nameValid || !emailValid || saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}
