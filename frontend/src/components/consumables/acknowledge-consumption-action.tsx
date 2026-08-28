'use client';

import * as React from 'react';
import { CheckCircle2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import {
  CONSUMABLE_CONSUMPTION_ACTION,
  kanbanRestockApi,
  type RestockRequest,
} from '@/lib/api/consumables';

/**
 * "Acknowledge" — record what a Kanban used up and close the request (KAN-001).
 *
 * **One dialog, not two.** This used to open a small form asking for the
 * quantity, whose Sign button then opened the signature dialog. Two dialogs for
 * one decision, and the first one held a single pre-filled number — so the
 * common path was: read a number, press Sign, read the same number again in the
 * attestation, press Sign again. The quantity now lives in the signature dialog
 * itself (its ``fields`` slot), above the sentence that quotes it.
 *
 * The number could not simply be dropped and defaulted, which was the obvious
 * shortcut: a request may carry NO requested quantity at all — "we're low" is a
 * legitimate ask — so there would be nothing to sign for. And what was
 * *requested* is not what was *used*; defaulting one to the other would put a
 * figure nobody stated into an attributable statement about material.
 *
 * **This moves no stock.** The units were debited when they were issued to the
 * Kanban (07-09 TRX-001), so what is recorded is how much of what we already
 * expensed actually got used. It is signed for the reason the expiry check is:
 * an attributable statement is still a statement (Part 11 §11.200).
 *
 * Shared by the production floor's Kanban tab and the item page's "Restock
 * requests" tab — the same request is answered from either, and a second copy
 * of a signed flow is how two surfaces start disagreeing about what was
 * attested.
 */
export function AcknowledgeConsumptionAction({
  request,
  onDone,
  size = 'sm',
  variant = 'secondary',
  label = 'Acknowledge',
}: {
  request: RestockRequest;
  onDone: () => void;
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'ghost' | 'primary';
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const submit = async (evidence: ReauthResponse) => {
    if (busy) return;
    setBusy(true);
    try {
      await kanbanRestockApi.acknowledgeConsumption(request.id, {
        note: evidence.comment?.trim() || null,
        evidence_id: evidence.evidence_id,
      });
      toast.success('Request acknowledged', {
        description: `${request.item_number} · ${request.kanban_path}`,
      });
      onDone();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Failed to acknowledge the request.',
      );
    } finally {
      setBusy(false);
    }
  };

  // Names the item AND the bin: several requests can be open at once, and the
  // signature has to say which one it answered (VR-006).
  //
  // It says what is TRUE and nothing more. This used to attest to a quantity —
  // "I confirm that N of X was used" — and with no quantity given it read
  // "0 was used", which is a false statement in a Part 11 attestation. A
  // signature is worth exactly as much as the sentence above it.
  const meaning =
    `I confirm the restock request for ${request.item_number} at ${request.kanban_path} ` +
    `has been actioned, and I am closing it.`;

  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)} disabled={busy}>
        <CheckCircle2 size={14} /> {label}
      </Button>

      <PasswordReauthDialog
        open={open}
        onOpenChange={setOpen}
        action={CONSUMABLE_CONSUMPTION_ACTION}
        // Bound to the request being closed, not to the bin (VR-006).
        recordTable="app.kanban_restock_requests"
        recordId={request.id}
        title="Acknowledge restock request"
        submitLabel="Sign & close"
        commentPlaceholder="Anything the next person should know"
        meaning={meaning}
        onConfirmed={submit}
      />
    </>
  );
}
