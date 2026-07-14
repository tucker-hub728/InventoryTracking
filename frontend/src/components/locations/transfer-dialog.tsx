'use client';

import * as React from 'react';
import { ArrowLeftRight } from 'lucide-react';

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
import { locationNodesApi, type Allocation } from '@/lib/api/location-nodes';
import {
  ReceiveLocationPicker,
  placementComplete,
  type AreaTrees,
  type PlacementValue,
} from '@/components/inventory/receipt-admin/receive-location-picker';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The source allocation being moved (freezer sub-location / warehouse shelf
   *  / box cell). */
  allocation: Allocation | null;
  /** Human label for the source location (breadcrumb). */
  sourceLabel?: string;
  onDone: () => void;
}

/**
 * Move units of one allocation to another storage leaf, anywhere across the
 * areas (LN2 ↔ Freezer ↔ Warehouse). E-signed (action ``movement.transfer``).
 */
export function TransferDialog({
  open,
  onOpenChange,
  allocation,
  sourceLabel,
  onDone,
}: Props) {
  const maxQty = allocation?.qty ?? 0;
  const [qty, setQty] = React.useState('1');
  const [placement, setPlacement] = React.useState<PlacementValue | null>(null);
  const [trees, setTrees] = React.useState<AreaTrees | null>(null);
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setQty(String(allocation?.qty ?? 1));
    setPlacement(null);
    setShowReauth(false);
    setSubmitting(false);
    setError(null);
  }, [open, allocation]);

  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    Promise.all([
      locationNodesApi.ln2Tree({ signal: ctrl.signal }),
      locationNodesApi.freezerTree({ signal: ctrl.signal }),
      locationNodesApi.warehouseTree({ signal: ctrl.signal }),
    ])
      .then(([ln2, freezer, warehouse]) =>
        setTrees({ ln2, freezer, warehouse }),
      )
      .catch(() => {});
    return () => ctrl.abort();
  }, [open]);

  const qtyNum = Number(qty);
  const qtyValid = Number.isInteger(qtyNum) && qtyNum >= 1 && qtyNum <= maxQty;

  const validate = (): string | null => {
    if (!allocation) return 'No source allocation.';
    if (!qtyValid) return `Quantity must be between 1 and ${maxQty}.`;
    if (!placementComplete(placement, qtyNum)) {
      return placement?.nodeType === 'box'
        ? `Select exactly ${qtyNum} cell(s) in the destination box.`
        : 'Choose a destination location.';
    }
    if (placement!.nodeId === allocation.location_node_id) {
      return 'Choose a destination different from the source.';
    }
    return null;
  };

  const openSign = () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setShowReauth(true);
  };

  const submit = async (evidence: ReauthResponse) => {
    if (!allocation || !placement) return;
    setSubmitting(true);
    setError(null);
    try {
      if (placement.nodeType === 'box') {
        await locationNodesApi.transferBatch({
          allocation_ids: [allocation.id],
          to_node_id: placement.nodeId,
          to_cells: placement.cells,
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
      } else {
        await locationNodesApi.transfer({
          allocation_id: allocation.id,
          to_node_id: placement.nodeId,
          qty: qtyNum,
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
      }
      toast.success('Transfer recorded', {
        description: `${qtyNum} unit${qtyNum === 1 ? '' : 's'} moved`,
      });
      onDone();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          setError('Your signature expired or was already used. Sign again.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Failed to record the transfer. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Transfer stock</DialogTitle>
            <DialogDescription>
              Move units of{' '}
              <span className="font-mono">{allocation?.lot_number ?? 'this lot'}</span>
              {sourceLabel ? ` from ${sourceLabel}` : ''} to another location.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tx-qty">Units to move</Label>
                <Input
                  id="tx-qty"
                  type="number"
                  min={1}
                  max={maxQty}
                  step={1}
                  className="font-mono"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                />
                <p className="text-xs text-text-3">{maxQty} available here.</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Destination</Label>
              {trees ? (
                <ReceiveLocationPicker
                  qty={qtyValid ? qtyNum : 0}
                  trees={trees}
                  value={placement}
                  onChange={setPlacement}
                />
              ) : (
                <p className="text-xs text-text-3">Loading locations…</p>
              )}
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
            <Button type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="button" variant="primary" onClick={openSign} disabled={submitting}>
              <ArrowLeftRight size={14} /> Sign &amp; transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action="movement.transfer"
        meaning={`I am transferring ${qtyNum} unit(s) of ${allocation?.lot_number ?? 'this lot'}.`}
        commentPlaceholder="e.g. Moved to freezer for cold storage"
        onConfirmed={submit}
        title="Sign this transfer"
        submitLabel="Sign & transfer"
      />
    </>
  );
}
