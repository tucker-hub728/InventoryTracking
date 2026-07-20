'use client';

import * as React from 'react';
import { ShieldCheck } from 'lucide-react';

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
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import { tiersApi, type ApiPrefix } from '@/lib/api/tiers';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tierId: string;
  tierName: string;
  /** When set, edits this prefix; otherwise creates a new one in the tier. */
  prefix?: ApiPrefix | null;
  onSaved: () => void;
}

/**
 * Create / edit an item prefix inside a tier (REQ-2026-07-15-ITM-002). Every
 * write is electronically signed — submitting opens the reauth dialog (action
 * ``prefix.create`` / ``prefix.update``); the typed comment becomes the audit
 * reason. A prefix never moves between tiers, so the owning tier is fixed.
 */
export function PrefixFormDialog({ open, onOpenChange, tierId, tierName, prefix, onSaved }: Props) {
  const isEdit = Boolean(prefix);

  const [code, setCode] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [isDefault, setIsDefault] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showReauth, setShowReauth] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setCode(prefix?.code ?? '');
    setLabel(prefix?.label ?? '');
    setIsDefault(prefix?.is_default ?? false);
    setError(null);
  }, [open, prefix]);

  // Un-defaulting the current default is rejected server-side — a tier always
  // needs one prefix to pre-fill the create form. Lock the toggle on in that case.
  const defaultLocked = isEdit && (prefix?.is_default ?? false);

  const openSign = () => {
    if (!code.trim()) {
      setError('Code is required.');
      return;
    }
    setError(null);
    setShowReauth(true);
  };

  const onConfirmed = async (evidence: ReauthResponse) => {
    const reason = evidence.comment ?? '';
    try {
      if (prefix) {
        await tiersApi.updatePrefix(tierId, prefix.id, {
          code: code.trim().toUpperCase(),
          label: label.trim() ? label.trim() : null,
          is_default: isDefault,
          evidence_id: evidence.evidence_id,
          reason,
        });
        toast.success('Prefix updated', { description: code.trim().toUpperCase() });
      } else {
        await tiersApi.createPrefix(tierId, {
          code: code.trim().toUpperCase(),
          label: label.trim() ? label.trim() : null,
          is_default: isDefault,
          evidence_id: evidence.evidence_id,
          reason,
        });
        toast.success('Prefix created', { description: code.trim().toUpperCase() });
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'prefix_code_conflict') {
          setError(`The prefix "${code.trim().toUpperCase()}" is already in use.`);
        } else if (err.code === 'prefix_default_required') {
          setError('A tier must keep one default prefix — set another as default first.');
        } else if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          setError('Your signature expired or was already used. Sign again.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Failed to save prefix.');
      }
    }
  };

  const codeUpper = code.trim().toUpperCase();

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit prefix' : 'New prefix'}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? `Rename or recolour this prefix in the ${tierName} tier.`
                : `Add a prefix to the ${tierName} tier. It lives inside this tier and can't create a new one.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="grid grid-cols-[120px_1fr] gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pf-code">Code</Label>
                <Input
                  id="pf-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="e.g. CR"
                  maxLength={8}
                  className="font-mono uppercase"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pf-label">Label (optional)</Label>
                <Input
                  id="pf-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Drug Finished Good"
                  maxLength={128}
                />
              </div>
            </div>
            <p className="-mt-2 text-xs text-text-3">
              Fronts every SKU with this prefix (e.g. {codeUpper || 'CR'}-001).
            </p>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface px-3 py-2">
              <div className="space-y-0.5">
                <Label htmlFor="pf-default">Default for this tier</Label>
                <p className="text-xs text-text-3">Pre-filled when this tier is chosen on new items.</p>
              </div>
              <Switch
                id="pf-default"
                checked={isDefault}
                disabled={defaultLocked}
                onCheckedChange={(v) => setIsDefault(v)}
              />
            </div>
            {defaultLocked && (
              <p className="-mt-2 text-xs text-text-3">
                This is the tier&apos;s default. Set another prefix as default to change it.
              </p>
            )}

            {error && (
              <p
                role="alert"
                className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
              >
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" variant="primary" onClick={openSign}>
              <ShieldCheck size={14} /> {isEdit ? 'Sign & save' : 'Sign & create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action={isEdit ? 'prefix.update' : 'prefix.create'}
        meaning={
          isEdit
            ? `I am editing the prefix "${codeUpper}" in the ${tierName} tier.`
            : `I am creating the prefix "${codeUpper}" in the ${tierName} tier.`
        }
        commentPlaceholder="e.g. New prefix for drug finished goods"
        onConfirmed={onConfirmed}
        title={isEdit ? 'Sign this prefix edit' : 'Sign this new prefix'}
        submitLabel="Sign"
      />
    </>
  );
}
