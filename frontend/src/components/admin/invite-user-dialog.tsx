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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import type { AssignableRole } from '@/lib/api/users';
import { invitationsApi, type InviteResult } from '@/lib/api/invitations';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful invite so the caller can refresh its list. */
  onInvited: () => void;
}

// super_admin is a fixed singleton — only admin/operator/read_only can be invited.
const ROLE_OPTIONS: { value: AssignableRole; label: string; hint: string }[] = [
  { value: 'read_only', label: 'Read-Only', hint: 'View inventory, ledger and audit — no changes' },
  { value: 'operator', label: 'Operator', hint: 'View, create / edit inventory and electronically sign' },
  { value: 'admin', label: 'Admin', hint: 'All inventory actions plus user management' },
];

const EMPTY = { email: '', first_name: '', last_name: '', role: 'read_only' as AssignableRole };

// Simple client-side format check; the backend + Cognito validate for real.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteUserDialog({ open, onOpenChange, onInvited }: Props) {
  const [form, setForm] = React.useState({ ...EMPTY });
  const [saving, setSaving] = React.useState(false);
  const [result, setResult] = React.useState<InviteResult | null>(null);

  // Reset both the form and any prior success state each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setForm({ ...EMPTY });
      setResult(null);
    }
  }, [open]);

  const patch = (p: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...p }));

  const email = form.email.trim();
  const valid =
    EMAIL_RE.test(email) && Boolean(form.first_name.trim()) && Boolean(form.last_name.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      const invite = await invitationsApi.create({
        email,
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        role: form.role,
      });
      setResult(invite);
      onInvited();
      toast.success(`Invitation created for ${invite.email}. A temporary password was emailed to them.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to create invitation.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {result ? (
          // ── Success: confirm the invitee was emailed a temporary password ──
          <>
            <DialogHeader>
              <DialogTitle>Invitation sent</DialogTitle>
              <DialogDescription>
                A temporary password was emailed to{' '}
                <strong className="text-text">{result.email}</strong>. They’ll be asked to set their
                own password the first time they sign in. It expires{' '}
                {new Date(result.expires_at).toLocaleDateString()}.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          // ── Form ─────────────────────────────────────────────────────────
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Invite user</DialogTitle>
              <DialogDescription>
                Create an account and email the new user a temporary password they use to set their
                own password.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="inv-email">Work email</Label>
                <Input
                  id="inv-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => patch({ email: e.target.value })}
                  placeholder="new.person@cellready.com"
                  autoComplete="off"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="inv-first">First name</Label>
                  <Input
                    id="inv-first"
                    value={form.first_name}
                    onChange={(e) => patch({ first_name: e.target.value })}
                    placeholder="Alex"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="inv-last">Last name</Label>
                  <Input
                    id="inv-last"
                    value={form.last_name}
                    onChange={(e) => patch({ last_name: e.target.value })}
                    placeholder="Rivera"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inv-role">Role</Label>
                <Select
                  value={form.role}
                  onValueChange={(v) => patch({ role: v as AssignableRole })}
                >
                  <SelectTrigger id="inv-role" aria-label="Role">
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
                <p className="text-xs text-text-3">
                  {ROLE_OPTIONS.find((r) => r.value === form.role)?.hint}
                </p>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!valid || saving}>
                {saving ? 'Creating…' : 'Create invitation'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
