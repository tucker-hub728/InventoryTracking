'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, ShieldCheck, Undo2 } from 'lucide-react';

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
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';

import { movementsApi, type ReverseInput } from '@/lib/api/movements';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import type { LedgerEntry } from '@/types/inventory';

// Reasons for reversing a movement. Captured separately from the
// original reason — Part 11 wants an explicit narrative for why an
// entry is being cancelled.
const REASON_OPTIONS = [
  { code: 'data_entry_error', label: 'Data entry error' },
  { code: 'wrong_item', label: 'Wrong item / lot picked' },
  { code: 'wrong_location', label: 'Wrong location' },
  { code: 'wrong_destination', label: 'Wrong destination (transfer)' },
  { code: 'cancelled', label: 'Action cancelled before completion' },
  { code: 'other', label: 'Other' },
];

const schema = z.object({
  reason_code: z.string().min(1, 'Pick a reason'),
  notes: z.string().max(2048).optional(),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The ledger row being reversed. ``movementId`` must be set. */
  entry: LedgerEntry | null;
  /** Called once the counter row(s) have been written. */
  onCompleted?: () => void;
}

/**
 * Confirms a single-row reversal under e-signature. The backend writes
 * a counter-movement (or two, for transfer pairs); the original stays
 * put on the ledger and the new row carries ``reversal_of_id``.
 *
 * Surfacing as a separate dialog (not inline on the row) because Part
 * 11 wants the operator to read the attestation and explicitly type
 * a reason before authorising — the "two clicks" rule.
 */
export function ReverseDialog({
  open,
  onOpenChange,
  entry,
  onCompleted,
}: Props) {
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    getValues,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      reason_code: 'data_entry_error',
      notes: '',
    },
  });

  const reasonCode = watch('reason_code');

  React.useEffect(() => {
    if (!open) {
      reset();
      setSubmitError(null);
      setShowReauth(false);
      setSubmitting(false);
    }
  }, [open, reset]);

  const reasonLabel =
    REASON_OPTIONS.find((o) => o.code === reasonCode)?.label ?? reasonCode;

  const isTransferLeg =
    entry?.movementType === 'transfer_in' || entry?.movementType === 'transfer_out';

  const attestation = entry
    ? `I attest this reversal of the ${entry.movementType ?? 'movement'} from ${entry.date} (lot ${entry.lot}, ${entry.in > 0 ? '+' + entry.in : '−' + entry.out} at ${entry.location}) for ${reasonLabel.toLowerCase()} is accurate.${
        isTransferLeg ? ' Both legs of the transfer will be reversed atomically.' : ''
      }`
    : '';

  const goToReview = (_values: FormValues): void => {
    if (!entry?.movementId) return;
    setShowReauth(true);
    setSubmitError(null);
  };

  const submit = async (evidence: ReauthResponse): Promise<void> => {
    if (!entry?.movementId) return;
    const v = getValues();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload: ReverseInput = {
        reason_code: v.reason_code,
        notes: v.notes ? v.notes : null,
        evidence_id: evidence.evidence_id,
      };
      const counters = await movementsApi.reverse(entry.movementId, payload);
      const first = counters[0];
      toast.success(
        counters.length === 2 ? 'Transfer reversed' : 'Movement reversed',
        {
          description: `${first?.item_number ?? ''} · ${counters.length} counter row(s) written`,
        },
      );
      onCompleted?.();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'movement_already_reversed') {
          setSubmitError(
            'This movement has already been reversed. Refresh the ledger.',
          );
        } else if (err.code === 'reversal_already_a_reversal') {
          setSubmitError(
            'You cannot reverse a reversal. Post a fresh receipt or adjustment instead.',
          );
        } else if (err.code === 'reversal_exceeds_available') {
          setSubmitError(err.message);
        } else if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          setSubmitError(
            'Your signature expired or was already used. Please sign again.',
          );
        } else {
          setSubmitError(err.message);
        }
      } else {
        setSubmitError('Failed to record reversal. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <form onSubmit={handleSubmit(goToReview)}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Undo2 size={16} aria-hidden /> Reverse movement
              </DialogTitle>
              <DialogDescription>
                Writes a counter-movement that cancels this row. The
                original stays on the ledger; the new row references it
                via ``reversal_of_id``.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-4">
              {entry && (
                <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1.5 rounded-md border border-border bg-bg-elev px-3 py-2.5 text-sm">
                  <dt className="text-xs text-text-3">Original</dt>
                  <dd className="font-mono text-xs">
                    {entry.movementType ?? '—'} · {entry.date}
                  </dd>
                  <dt className="text-xs text-text-3">Lot</dt>
                  <dd className="font-mono text-xs">{entry.lot}</dd>
                  <dt className="text-xs text-text-3">Location</dt>
                  <dd className="font-mono text-xs">{entry.location}</dd>
                  <dt className="text-xs text-text-3">Quantity</dt>
                  <dd className="font-mono text-xs">
                    {entry.in > 0 ? (
                      <span className="text-success">+{entry.in}</span>
                    ) : (
                      <span className="text-warning">−{entry.out}</span>
                    )}
                  </dd>
                  {isTransferLeg && (
                    <>
                      <dt className="text-xs text-text-3">Transfer</dt>
                      <dd className="text-xs text-text-2">
                        Both legs reverse together
                      </dd>
                    </>
                  )}
                </dl>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="rv-reason">
                  Reason for reversal <span className="text-danger">*</span>
                </Label>
                <Select
                  value={reasonCode || ''}
                  onValueChange={(v) =>
                    setValue('reason_code', v, { shouldValidate: true })
                  }
                >
                  <SelectTrigger
                    id="rv-reason"
                    aria-invalid={Boolean(errors.reason_code)}
                  >
                    <SelectValue placeholder="Reason" />
                  </SelectTrigger>
                  <SelectContent>
                    {REASON_OPTIONS.map((o) => (
                      <SelectItem key={o.code} value={o.code}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.reason_code && (
                  <p role="alert" className="text-xs text-danger">
                    {errors.reason_code.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="rv-notes">Narrative (optional)</Label>
                <Input
                  id="rv-notes"
                  placeholder="What happened, and how was it caught?"
                  {...register('notes')}
                />
              </div>

              {submitError && (
                <p
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
                >
                  {submitError}
                </p>
              )}
            </DialogBody>

            <DialogFooter>
              <Button
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={submitting || !entry?.movementId}
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Recording…
                  </>
                ) : (
                  <>
                    <ShieldCheck size={14} /> Sign & reverse
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action="movement.reverse"
        meaning={attestation}
        onConfirmed={submit}
        title="Sign this reversal"
        submitLabel="Sign & reverse"
      />
    </>
  );
}
