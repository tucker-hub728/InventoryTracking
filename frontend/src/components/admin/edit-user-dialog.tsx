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
import { usersApi, type ApiUser, type AssignableRole, type UserUpdateInput } from '@/lib/api/users';

// Only admin/operator/read_only are assignable — super_admin is a fixed singleton.
const ROLE_OPTIONS: { value: AssignableRole; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'operator', label: 'Operator' },
  { value: 'read_only', label: 'Read-Only' },
];

const roleLabel = (role: string) =>
  role === 'super_admin'
    ? 'Super Admin'
    : (ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role);

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: ApiUser | null;
  onSaved: (updated: ApiUser) => void;
}

export function EditUserDialog({ open, onOpenChange, user, onSaved }: Props) {
  const { confirm, confirmDialog } = useConfirm();
  const [fullName, setFullName] = React.useState('');
  const [role, setRole] = React.useState<AssignableRole>('read_only');
  const [active, setActive] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  // Seed the form from the selected user each time the dialog opens.
  React.useEffect(() => {
    if (open && user) {
      setFullName(user.full_name);
      setRole((user.role as AssignableRole) ?? 'read_only');
      setActive(user.is_active);
    }
  }, [open, user]);

  if (!user) return null;

  // Super admins keep their role + status here — only their name is editable.
  const isSuperAdmin = user.role === 'super_admin';
  const nameValid = Boolean(fullName.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameValid || saving) return;

    const changes: UserUpdateInput = {};
    if (fullName.trim() !== user.full_name) changes.full_name = fullName.trim();
    if (!isSuperAdmin) {
      if (role !== user.role) changes.role = role;
      if (active !== user.is_active) changes.is_active = active;
    }

    if (Object.keys(changes).length === 0) {
      onOpenChange(false);
      return;
    }

    // A role change is consequential — confirm it explicitly.
    if (changes.role) {
      const proceed = await confirm({
        title: 'Change role?',
        description: `${user.email} will become ${roleLabel(changes.role)}. This changes what they can access.`,
        confirmLabel: 'Change role',
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
                {isSuperAdmin
                  ? 'Super admins keep their role and status — only the name can be changed here.'
                  : 'Update the name, role, and active status.'}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="edit-name">Full name</Label>
                <Input
                  id="edit-name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-email">Email</Label>
                {/* Email edits aren't supported yet — shown read-only for context. */}
                <Input id="edit-email" value={user.email} disabled readOnly />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-role">Role</Label>
                {isSuperAdmin ? (
                  // The single super admin's role can't be changed here.
                  <Input id="edit-role" value="Super Admin" disabled readOnly />
                ) : (
                  <Select value={role} onValueChange={(v) => setRole(v as AssignableRole)}>
                    <SelectTrigger id="edit-role" aria-label="Role">
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
                )}
              </div>

              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                <div>
                  <Label htmlFor="edit-active" className="cursor-pointer">
                    Active
                  </Label>
                  <p className="text-xs text-text-3">
                    {isSuperAdmin
                      ? 'Super admins can’t be deactivated here.'
                      : 'Inactive users can’t sign in or use the app (disabled in Cognito).'}
                  </p>
                </div>
                <Switch
                  id="edit-active"
                  checked={active}
                  onCheckedChange={setActive}
                  disabled={isSuperAdmin}
                />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!nameValid || saving}>
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
