'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ShieldCheck, Trash2 } from 'lucide-react';

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { toast } from '@/components/ui/sonner';
import type { Role, User, UserStatus } from '@/types/auth';

const schema = z.object({
  role: z.enum(['admin', 'editor', 'viewer']),
  status: z.enum(['active', 'invited', 'suspended']),
});

type Values = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User | null;
  roles: Role[];
}

export function UserSheet({ open, onOpenChange, user, roles }: Props) {
  const [suspending, setSuspending] = React.useState(false);
  const { setValue, watch, handleSubmit, reset, formState: { isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { role: user?.role ?? 'viewer', status: (user?.status as UserStatus) ?? 'active' },
  });

  React.useEffect(() => {
    if (user) reset({ role: user.role, status: user.status });
  }, [user, reset]);

  const role = watch('role');
  const status = watch('status');
  const r = roles.find((x) => x.id === role);

  const onSubmit = async (data: Values): Promise<void> => {
    await new Promise((r) => setTimeout(r, 250));
    toast.success('Access updated', { description: `${user?.name} · ${data.role}` });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        {user && (
          <form onSubmit={handleSubmit(onSubmit)} className="flex h-full flex-col">
            <SheetHeader>
              <SheetDescription>{user.id}</SheetDescription>
              <SheetTitle>{user.name}</SheetTitle>
            </SheetHeader>
            <SheetBody className="space-y-6">
              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-3">
                  Profile
                </h3>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <ReadOnly k="Email" v={user.email} />
                  <ReadOnly k="Last active" v={user.lastActive} />
                </dl>
              </section>

              <Separator />

              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-text-3">
                  Access
                </h3>
                <div className="space-y-1.5">
                  <Label htmlFor="role">Role</Label>
                  <Select value={role} onValueChange={(v) => setValue('role', v as Values['role'])}>
                    <SelectTrigger id="role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roles.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="status">Status</Label>
                  <Select value={status} onValueChange={(v) => setValue('status', v as Values['status'])}>
                    <SelectTrigger id="status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="invited">Invited (awaiting first sign-in)</SelectItem>
                      <SelectItem value="suspended">Suspended</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </section>

              {r && (
                <section className="space-y-2 rounded-md border border-border bg-surface p-3 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold text-text-2">
                    <ShieldCheck size={12} /> Permissions inherited from{' '}
                    {`"${r.name}"`}
                  </div>
                  <p className="text-text-3">{r.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(['inventory', 'users', 'audit'] as const).map((group) => {
                      const bucket = r.perms[group] as unknown as Record<string, boolean>;
                      const allowedActions = Object.entries(bucket)
                        .filter(([, v]) => v)
                        .map(([k]) => k);
                      if (allowedActions.length === 0) return null;
                      return (
                        <Badge key={group} tone="accent">
                          {group}: {allowedActions.join(', ')}
                        </Badge>
                      );
                    })}
                  </div>
                </section>
              )}
            </SheetBody>
            <SheetFooter>
              <Button
                type="button"
                variant="danger"
                size="sm"
                className="mr-auto"
                onClick={() => setSuspending(true)}
              >
                <Trash2 size={13} /> Suspend
              </Button>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={isSubmitting}>
                Save changes
              </Button>
            </SheetFooter>
          </form>
        )}
      </SheetContent>

      <ConfirmDialog
        open={suspending}
        onOpenChange={setSuspending}
        title={`Suspend ${user?.name}?`}
        description="They’ll lose access immediately and can be reactivated later."
        confirmLabel="Suspend"
        variant="danger"
        onConfirm={async () => {
          await new Promise((r) => setTimeout(r, 250));
          toast.success('User suspended');
          onOpenChange(false);
        }}
      />
    </Sheet>
  );
}

function ReadOnly({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-text-3">{k}</dt>
      <dd className="mt-0.5 text-sm">{v}</dd>
    </div>
  );
}
