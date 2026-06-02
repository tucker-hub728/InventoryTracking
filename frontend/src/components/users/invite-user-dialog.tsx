'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AtSign, Mail, User2 } from 'lucide-react';

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
import { Separator } from '@/components/ui/separator';
import { siteConfig } from '@/config/site';
import { toast } from '@/components/ui/sonner';
import type { Role, RoleId } from '@/types/auth';

const schema = z.object({
  name: z.string().min(2, 'Name is required'),
  email: z.string().email('Invalid email'),
  role: z.enum(['admin', 'editor', 'viewer']),
});

type Values = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: Role[];
}

/**
 * Two-step invite flow:
 *   1. Collect name/email/role
 *   2. Preview the email + send. Token is generated client-side for demo.
 */
export function InviteUserDialog({ open, onOpenChange, roles }: Props) {
  const [preview, setPreview] = React.useState<Values | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', role: 'viewer' },
  });

  React.useEffect(() => {
    if (!open) {
      reset();
      setPreview(null);
    }
  }, [open, reset]);

  const onSubmit = (data: Values) => setPreview(data);
  const role = watch('role');

  const send = async () => {
    if (!preview) return;
    await new Promise((r) => setTimeout(r, 350));
    toast.success('Invitation sent', { description: `An email was sent to ${preview.email}.` });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {!preview ? (
          <form onSubmit={handleSubmit(onSubmit)}>
            <DialogHeader>
              <DialogTitle>Invite user</DialogTitle>
              <DialogDescription>
                Send an account invitation. The recipient sets their password on first sign-in.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="iu-name">Full name</Label>
                <Input id="iu-name" icon={User2} aria-invalid={Boolean(errors.name)} {...register('name')} />
                {errors.name && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.name.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="iu-email">Work email</Label>
                <Input
                  id="iu-email"
                  type="email"
                  icon={AtSign}
                  aria-invalid={Boolean(errors.email)}
                  {...register('email')}
                />
                {errors.email && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.email.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="iu-role">Role</Label>
                <Select
                  value={role}
                  onValueChange={(v) => setValue('role', v as RoleId, { shouldValidate: true })}
                >
                  <SelectTrigger id="iu-role">
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
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary">
                <Mail size={14} /> Preview email
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Preview & send</DialogTitle>
              <DialogDescription>
                Review the email before sending. The recipient has 7 days to accept.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <dl className="grid grid-cols-3 gap-3 rounded-md border border-border bg-surface p-3 text-sm">
                <div>
                  <dt className="text-xs text-text-3">To</dt>
                  <dd className="font-medium">{preview.name}</dd>
                  <dd className="text-xs text-text-3">{preview.email}</dd>
                </div>
                <div>
                  <dt className="text-xs text-text-3">Role</dt>
                  <dd className="font-medium">
                    {roles.find((r) => r.id === preview.role)?.name}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-text-3">Expires</dt>
                  <dd className="font-medium">In 7 days</dd>
                </div>
              </dl>
              <Separator />
              <EmailPreview invitee={preview.name} role={preview.role} />
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setPreview(null)}>
                Back
              </Button>
              <Button type="button" variant="primary" onClick={send}>
                <Mail size={14} /> Send invitation
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EmailPreview({ invitee, role }: { invitee: string; role: RoleId }) {
  return (
    <div className="rounded-md border border-border bg-bg-elev p-5 text-sm leading-relaxed">
      <div className="mb-3 text-xs text-text-3">
        Subject: <span className="font-medium text-text">You’ve been invited to {siteConfig.shortName}</span>
      </div>
      <p>Hi {invitee.split(' ')[0]},</p>
      <p className="mt-2">
        You’ve been added as a <strong>{role}</strong> on {siteConfig.shortName}, our 21 CFR Part 11
        cell-therapy inventory system.
      </p>
      <p className="mt-2">
        Click the secure link below to set your password. The link expires in 7 days.
      </p>
      <div className="mt-3 inline-block rounded-md bg-accent px-4 py-2 text-xs font-medium text-white">
        Activate your account →
      </div>
      <p className="mt-3 text-xs text-text-3">
        If you weren’t expecting this, you can safely ignore the email. — The {siteConfig.shortName} team
      </p>
    </div>
  );
}
