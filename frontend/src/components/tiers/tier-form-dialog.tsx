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
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import {
  tiersApi,
  TIER_TYPE_LABELS,
  type ApiTier,
  type TierType,
  type TierTone,
} from '@/lib/api/tiers';
import { cn } from '@/lib/utils';
import type { BadgeTone } from '@/types/ui';

const TONES: TierTone[] = ['neutral', 'accent', 'success', 'warning', 'danger'];

const TONE_DOT: Record<BadgeTone, string> = {
  neutral: 'bg-text-3',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, edits this tier (type is immutable); otherwise creates. */
  tier?: ApiTier | null;
  onSaved: () => void;
}

/**
 * Create / edit an item tier. Every write is electronically signed —
 * submitting opens the reauth dialog (action ``tier.create`` /
 * ``tier.update``); the typed comment becomes the audit reason.
 */
export function TierFormDialog({ open, onOpenChange, tier, onSaved }: Props) {
  const isEdit = Boolean(tier);

  const [name, setName] = React.useState('');
  const [type, setType] = React.useState<TierType>('raw_material');
  const [tone, setTone] = React.useState<TierTone>('accent');
  const [error, setError] = React.useState<string | null>(null);
  const [showReauth, setShowReauth] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(tier?.name ?? '');
    setType((tier?.type as TierType) ?? 'raw_material');
    setTone((tier?.tone as TierTone) ?? 'accent');
    setError(null);
  }, [open, tier]);

  const openSign = () => {
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setError(null);
    setShowReauth(true);
  };

  const onConfirmed = async (evidence: ReauthResponse) => {
    const reason = evidence.comment ?? '';
    try {
      if (tier) {
        await tiersApi.update(tier.id, {
          name: name.trim(),
          tone,
          evidence_id: evidence.evidence_id,
          reason,
        });
        toast.success('Tier updated', { description: name.trim() });
      } else {
        await tiersApi.create({
          name: name.trim(),
          type,
          tone,
          evidence_id: evidence.evidence_id,
          reason,
        });
        toast.success('Tier created', { description: name.trim() });
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'tier_name_conflict') {
          setError(`A tier named "${name.trim()}" already exists.`);
        } else if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          setError('Your signature expired or was already used. Sign again.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Failed to save tier.');
      }
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit tier' : 'New tier'}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'Rename or recolour. The tier type is fixed at creation.'
                : 'A tier decides how its items are treated: raw materials are bought; sub-assemblies and finished goods are built from a BOM.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cat-name">Name</Label>
              <Input
                id="cat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Consumables"
                autoFocus
              />
            </div>
            <p className="-mt-2 text-xs text-text-3">
              Prefixes for this tier are managed from the tier&apos;s row on the Item Tiers page.
            </p>

            <div className="space-y-1.5">
              <Label>Type</Label>
              <div
                className="flex w-fit overflow-hidden rounded-md border border-border-strong"
                role="radiogroup"
                aria-label="Tier type"
              >
                {(
                  ['raw_material', 'sub_assembly', 'finished_good'] as TierType[]
                ).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={type === k}
                    disabled={isEdit}
                    onClick={() => setType(k)}
                    className={cn(
                      'px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed',
                      type === k
                        ? 'bg-accent text-white'
                        : 'bg-bg-elev text-text-2 hover:bg-surface disabled:hover:bg-bg-elev',
                    )}
                  >
                    {TIER_TYPE_LABELS[k]}
                  </button>
                ))}
              </div>
              {isEdit && (
                <p className="text-xs text-text-3">Type can&apos;t change after creation.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Colour</Label>
              <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Colour">
                {TONES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={tone === t}
                    aria-label={t}
                    onClick={() => setTone(t)}
                    className={cn(
                      'size-5 rounded-full ring-offset-2 ring-offset-bg-elev transition',
                      TONE_DOT[t],
                      tone === t ? 'ring-2 ring-accent' : 'opacity-50 hover:opacity-100',
                    )}
                  />
                ))}
              </div>
            </div>

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
        action={isEdit ? 'tier.update' : 'tier.create'}
        meaning={
          isEdit
            ? `I am editing the item tier "${name.trim()}".`
            : `I am creating the item tier "${name.trim()}".`
        }
        commentPlaceholder="e.g. New tier for QA holds"
        onConfirmed={onConfirmed}
        title={isEdit ? 'Sign this tier edit' : 'Sign this new tier'}
        submitLabel="Sign"
      />
    </>
  );
}
