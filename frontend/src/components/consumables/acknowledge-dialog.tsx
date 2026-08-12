'use client';

import * as React from 'react';
import { CheckCircle2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import {
  CONSUMABLE_EXPIRY_CHECK_ACTION,
  consumablesApi,
  DISPOSITION_LABEL,
  DISPOSITIONS,
  type Disposition,
  type IssuedConsumable,
} from '@/lib/api/consumables';
import { refreshNavCounts } from '@/hooks/use-nav-counts';
import { cn } from '@/lib/utils';

/** One-line explanation per outcome, so the operator picks by meaning rather
 *  than by guessing what the label implies for stock. */
const DISPOSITION_HINT: Record<Disposition, string> = {
  consumed: 'Used up in the room before its date.',
  reworked: 'Taken out and reprocessed.',
  retested: 'Taken out and sent for retesting.',
  discarded: 'Taken out and thrown away.',
};

/** First person, past tense — this is what the operator's password attests to,
 *  so it states the outcome rather than naming the enum value. */
const DISPOSITION_MEANING: Record<Disposition, string> = {
  consumed: 'was used up before its expiration date',
  reworked: 'was removed from the station and reprocessed',
  retested: 'was removed from the station and sent for retesting',
  discarded: 'was removed from the station and discarded',
};

/**
 * Close out one issued consumable after the physical check
 * (REQ-2026-07-01-LOC-008, Transaction Spec §4.2).
 *
 * Shared by the production floor's Kanban tab and the cross-area Expiring
 * page — the two places a flag is answered. It lived in both files until the
 * second copy started drifting.
 *
 * **E-signed** (client 2026-08-12), action `consumable.expiry_check`. 07-09
 * TRX-006 calls this "a simple acknowledgment" and no quantity moves, which is
 * why it was first built unsigned; the disposition is what changed the reading.
 * "Discarded" / "consumed before its date" is an attributable statement about
 * what became of material, and it is the only record of that outcome anywhere —
 * the ledger stopped at the issue. So the password is asked for, and "simple"
 * is honoured as *one step, no quantities to reconcile*: pick the outcome, sign,
 * done.
 *
 * The signature's optional comment IS the note kept on the register row, the
 * same trade the issue dialog makes — one place to explain yourself, not two
 * free-text boxes back to back.
 *
 * The summary block is not decoration — TRX-006 requires the acknowledgment to
 * show WHERE and WHEN the flagged material was issued.
 */
export function AcknowledgeDialog({
  row,
  onOpenChange,
  onDone,
}: {
  /** The register row being closed out; `null` keeps the dialog shut. */
  row: IssuedConsumable | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [disposition, setDisposition] = React.useState<Disposition>('discarded');
  const [showReauth, setShowReauth] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (row) {
      // An unflagged row is almost always being closed out because the stock
      // was used up early (§4.2's first condition); a flagged one is usually a
      // check that ended in the bin. Default to the likely answer.
      setDisposition(row.flag === null ? 'consumed' : 'discarded');
      setError(null);
      setBusy(false);
    }
  }, [row]);

  const submit = async (evidence: ReauthResponse) => {
    if (!row || busy) return;
    setBusy(true);
    setError(null);
    try {
      await consumablesApi.acknowledge(row.id, {
        disposition,
        // Whatever the operator typed on the signature is the note the next
        // person reads on the register — it is recorded in both places.
        note: evidence.comment?.trim() || null,
        evidence_id: evidence.evidence_id,
      });
      toast.success('Check recorded', {
        description: `${row.item_number} — ${DISPOSITION_LABEL[disposition].toLowerCase()}`,
      });
      // The sidebar count just changed; correct it now rather than at the next
      // navigation.
      refreshNavCounts();
      onDone();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'reauth_evidence_replayed' || err.code === 'reauth_evidence_expired') {
          setError('Your signature expired or was already used. Sign again.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Failed to record the check.');
      }
      setBusy(false);
    }
  };

  // Names the lot and the station, because the operator may have several
  // flagged rows open and a signature has to say which one it answered.
  const meaning = row
    ? `I have physically checked ${row.item_number}${
        row.lot_number ? ` (Lot ${row.lot_number})` : ''
      } ×${row.qty} at ${row.kanban_path} and confirm it ${
        DISPOSITION_MEANING[disposition]
      }.`
    : '';

  return (
    <>
      <Dialog open={row !== null} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record expiry check</DialogTitle>
            <DialogDescription>
              Confirm what happened to this stock. It stays in the register with the outcome
              recorded, and stops appearing in the alerts.
            </DialogDescription>
          </DialogHeader>
          {row && (
            <DialogBody className="space-y-4">
              <div className="rounded-md border border-border bg-surface-2 px-3 py-2.5 text-xs">
                <p className="font-medium text-text">
                  {row.item_number} ×{row.qty}
                  {row.lot_number && <span className="text-text-3"> · Lot {row.lot_number}</span>}
                </p>
                <p className="mt-1 text-text-3">
                  Issued to {row.kanban_path} on {new Date(row.issued_at).toLocaleDateString()}
                  {row.issued_by && <> by {row.issued_by}</>}
                </p>
                {row.expiration_date && (
                  <p
                    className={cn(
                      'mt-0.5',
                      // Only colour a date that is actually raising a flag —
                      // amber on a 2029 expiry reads as a warning that isn't one.
                      row.flag === 'expired'
                        ? 'text-danger'
                        : row.flag === 'warn'
                          ? 'text-warning'
                          : 'text-text-3',
                    )}
                  >
                    {row.flag === 'expired' ? 'Expired' : 'Expires'}{' '}
                    {new Date(row.expiration_date).toLocaleDateString()}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ack-disposition">
                  Disposition <span className="text-danger">*</span>
                </Label>
                <Select
                  value={disposition}
                  onValueChange={(v) => setDisposition(v as Disposition)}
                >
                  <SelectTrigger id="ack-disposition" aria-label="Disposition">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DISPOSITIONS.map((d) => (
                      <SelectItem key={d} value={d}>
                        {DISPOSITION_LABEL[d]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-text-3">{DISPOSITION_HINT[disposition]}</p>
              </div>

              <p className="text-xs text-text-3">
                You will be asked for your password — the outcome is recorded against your
                name, with an optional note for the next person.
              </p>

              {error && (
                <p
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
                >
                  {error}
                </p>
              )}
            </DialogBody>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setError(null);
                setShowReauth(true);
              }}
              disabled={busy}
            >
              <CheckCircle2 size={14} /> {busy ? 'Recording…' : 'Sign & record check'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action={CONSUMABLE_EXPIRY_CHECK_ACTION}
        // The register row itself is what is on screen and what is changing, so
        // it is what the signature is bound to (VR-006).
        recordTable="app.consumable_issues"
        recordId={row?.id}
        meaning={meaning}
        commentPlaceholder="Anything the next person should know"
        onConfirmed={submit}
        title="Sign this expiry check"
        submitLabel="Sign & record check"
      />
    </>
  );
}
