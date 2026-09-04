'use client';

import * as React from 'react';
import { AlertCircle, PackageCheck, ShieldCheck } from 'lucide-react';

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
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import { locationNodesApi } from '@/lib/api/location-nodes';
import type { ApiAwaitingPutAway } from '@/lib/api/items';
import { formatDate, formatNumber } from '@/lib/utils';

import {
  ReceiveLocationPicker,
  placementComplete,
  type AreaTrees,
  type PlacementValue,
} from './receive-location-picker';

/**
 * Step two of receiving: put arrived material away, and release it (REQ-004).
 *
 * The requirement draws the line precisely — "the receive-to-inventory step
 * (setting location, expiration, sign-off) represents the move from quarantine
 * to accepted/released material and occurs at release, not at physical
 * arrival." Everything on this screen is that step. Arrival happened earlier
 * and captured what turned up; this is where somebody says where it went and
 * that it may be used.
 *
 * One dialog and one signature for both, because it is one decision. Splitting
 * "place" from "release" would ask for two signatures for a single act and
 * leave a window where stock is on a shelf and still labelled quarantine.
 *
 * The copy leans on that: the button says **Sign & release**, not "Save". The
 * operator is attesting, not filing.
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The queued lot being put away. Null closes the dialog. */
  lot: ApiAwaitingPutAway | null;
  itemNumber?: string | null;
  itemDescription?: string | null;
  /** Fired after a successful put-away so the host can refresh its queue. */
  onDone: () => void;
}

export function PutAwayDialog({
  open,
  onOpenChange,
  lot,
  itemNumber,
  itemDescription,
  onDone,
}: Props) {
  const [trees, setTrees] = React.useState<AreaTrees | null>(null);
  const [placement, setPlacement] = React.useState<PlacementValue | null>(null);
  // Pre-filled from what arrival recorded. Editable because this is the step
  // that confirms it — the carton is usually still in the operator's hand here,
  // and a wrong date entered at the door is cheapest to fix now.
  const [expiry, setExpiry] = React.useState('');
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const remaining = lot?.remaining_units ?? 0;
  const partial = Boolean(lot && lot.remaining_units < lot.received_units);

  React.useEffect(() => {
    if (!open || !lot) return;
    setPlacement(null);
    setExpiry(lot.expiration_date ?? '');
    setFormError(null);
    setShowReauth(false);
    setSubmitting(false);
  }, [open, lot]);

  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    Promise.all([
      locationNodesApi.ln2Tree({ signal: ctrl.signal }),
      locationNodesApi.freezerTree({ signal: ctrl.signal }),
      locationNodesApi.warehouseTree({ signal: ctrl.signal }),
    ])
      .then(([ln2, freezer, warehouse]) => setTrees({ ln2, freezer, warehouse }))
      .catch(() => {
        /* the picker shows its own empty state if targets can't load */
      });
    return () => ctrl.abort();
  }, [open]);

  const isBox = placement?.nodeType === 'box';
  // Always the whole remainder. There is no quantity field: the header already
  // states how much arrived, and an input pre-filled with that same number only
  // ever restated it. A box still carries its quantity in the cell count, which
  // must therefore cover the whole remainder too.
  const placingQty = isBox ? placement.cells.length : remaining;

  const validate = (): string | null => {
    if (!lot) return 'Nothing selected.';
    if (!placement?.nodeId) return 'Choose where these units go.';
    if (remaining <= 0) return 'Nothing left to place on this lot.';
    // A box needs one free cell per unit, and the whole remainder goes at once,
    // so anything short of a full set is incomplete rather than a partial.
    if (isBox && !placementComplete(placement, remaining)) {
      return `Select ${formatNumber(remaining)} cell(s) — one per unit.`;
    }
    return null;
  };

  const openSign = () => {
    const problem = validate();
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    setShowReauth(true);
  };

  const submit = async (evidence: ReauthResponse) => {
    if (!lot || !placement) return;
    setSubmitting(true);
    try {
      await locationNodesApi.receiveToInventory({
        lot_id: lot.lot_id,
        node_id: placement.nodeId,
        // Exactly one of these — the server rejects the wrong shape for the
        // destination rather than guessing which field it meant.
        ...(isBox ? { cells: placement.cells } : { qty: placingQty }),
        expiration_date: expiry || null,
        evidence_id: evidence.evidence_id,
      });
      toast.success('Received to inventory', {
        description: `${formatNumber(placingQty)} unit(s) placed and released.`,
      });
      setShowReauth(false);
      onOpenChange(false);
      onDone();
    } catch (err) {
      setShowReauth(false);
      setFormError(
        err instanceof ApiError ? err.message : 'Could not receive to inventory.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Receive to inventory</DialogTitle>
            <DialogDescription>
              Choose where this material goes. Placing it releases it from
              quarantine and makes it available to use — recorded under your
              e-signature.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {lot && (
              <div className="rounded-md border border-border bg-surface p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="break-all font-mono text-xs text-accent">
                    {lot.lot_number}
                  </span>
                  <span className="tabular-nums text-sm font-medium text-text-1">
                    {formatNumber(remaining)}
                    <span className="ml-1 text-xs font-normal text-text-3">
                      unit{remaining === 1 ? '' : 's'} to place
                    </span>
                  </span>
                </div>
                <p className="mt-1 text-xs text-text-3">
                  {itemNumber && <span className="font-mono">{itemNumber}</span>}
                  {itemDescription ? ` ${itemDescription}` : ''}
                  {lot.po_reference ? ` · ${lot.po_reference}` : ''}
                  {lot.received_at ? ` · arrived ${formatDate(lot.received_at)}` : ''}
                </p>
                {/* Only when it is NOT the whole lot — otherwise the line
                    restates the number directly above it. */}
                {partial && (
                  // Muted, not amber. Splitting a lot across two locations is a
                  // legitimate thing to do, so the note is context, not a
                  // complaint about the operator's earlier decision.
                  <p className="mt-1 text-xs text-text-3">
                    {formatNumber(lot.received_units - remaining)} of{' '}
                    {formatNumber(lot.received_units)} already placed earlier.
                  </p>
                )}
              </div>
            )}

            {/* Expiration is the only thing to type here. The quantity is
                whatever arrived, and the destination has its own picker below,
                so a two-column row would leave a hole beside this. */}
            <div className="max-w-xs space-y-1.5">
              <Label htmlFor="pa-expiry">Expiration date</Label>
              <Input
                id="pa-expiry"
                type="date"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
              <p className="text-[11px] text-text-3">
                {lot?.expiration_date
                  ? 'Recorded at arrival — confirm or correct it.'
                  : 'Not recorded at arrival.'}
              </p>
            </div>

            <div className="space-y-1.5 border-t border-border pt-3">
              <Label>
                Destination <span className="text-danger">*</span>
              </Label>
              {trees ? (
                <ReceiveLocationPicker
                  qty={remaining}
                  trees={trees}
                  value={placement}
                  onChange={setPlacement}
                />
              ) : (
                <p className="text-xs text-text-3">Loading locations…</p>
              )}
            </div>

            {formError && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
              >
                <AlertCircle size={14} className="mt-px shrink-0" />
                {formError}
              </p>
            )}
          </DialogBody>

          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={openSign} disabled={submitting || !lot}>
              <ShieldCheck size={14} />
              {/* Names the act, not the mechanism. This signature is an
                  attestation that the material may be used. */}
              Sign &amp; release
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action="receipt.release"
        // Bind the signature to the LOT (VR-006). The server checks this, so a
        // ticket minted here cannot be spent releasing a different batch.
        recordTable="app.lots"
        recordId={lot?.lot_id}
        title="Sign to release"
        meaning={
          lot
            ? `I am placing ${formatNumber(placingQty)} unit(s) of lot ${lot.lot_number} into ${
                placement?.nodeId ? 'the selected location' : 'inventory'
              } and releasing them from quarantine for use.`
            : ''
        }
        submitLabel="Sign & release"
        commentPlaceholder="Reason or note for this release (optional)"
        onConfirmed={submit}
      />
    </>
  );
}

/** Small icon used by hosts that surface the queue, kept next to the dialog so
 *  the affordance and the action stay recognisably the same feature. */
export const PutAwayIcon = PackageCheck;
