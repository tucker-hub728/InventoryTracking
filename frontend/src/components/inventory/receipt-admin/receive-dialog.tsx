'use client';

import * as React from 'react';
import { AlertCircle, ShieldCheck } from 'lucide-react';

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
import {
  receivingApi,
  type Order,
  type OrderLine,
  type ReceiveEventInput,
  type ReceiveEventLineInput,
} from '@/lib/api/receiving';
import {
  ReceiveLocationPicker,
  placementComplete,
  type AreaTrees,
  type PlacementValue,
} from './receive-location-picker';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface LineDraft {
  include: boolean;
  qty_received: string;
  lot_number: string;
  manufacture_date: string;
  expiration_date: string;
  unit_price: string;
  /** Where the received units go (unit-in) — chosen in the same signed step. */
  placement: PlacementValue | null;
}

function seedLineDraft(line: OrderLine): LineDraft {
  return {
    include: false,
    qty_received: String(line.outstanding_qty),
    lot_number: '',
    manufacture_date: '',
    expiration_date: '',
    unit_price: line.unit_price_amount ?? '',
    placement: null,
  };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: Order | null;
  onReceived: (order: Order) => void;
}

/**
 * Dated receive event (Receipt Admin v3). For each outstanding line the
 * operator enters a qty + lot number (+ optional mfg/expiry/price); a lot is
 * created per included line. Partial receipts are allowed (skip lines or
 * receive fewer than outstanding); over-receipt (qty > outstanding) is allowed
 * with no reason. The whole event is covered by one e-signature
 * (``receipt.confirm``).
 */
export function ReceiveDialog({ open, onOpenChange, order, onReceived }: Props) {
  const [receivedAt, setReceivedAt] = React.useState(todayIso);
  const [drafts, setDrafts] = React.useState<Record<string, LineDraft>>({});
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [errorLineId, setErrorLineId] = React.useState<string | null>(null);
  const [trees, setTrees] = React.useState<AreaTrees | null>(null);
  const lineRefs = React.useRef<Record<string, HTMLDivElement | null>>({});

  /** Show a validation failure and bring the line that caused it into view. */
  const fail = (message: string, lineId?: string) => {
    setFormError(message);
    setErrorLineId(lineId ?? null);
    if (lineId) {
      lineRefs.current[lineId]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  };

  const outstandingLines = React.useMemo(
    () => (order?.lines ?? []).filter((l) => l.outstanding_qty > 0),
    [order],
  );

  // Seed one draft per outstanding line when the dialog opens.
  React.useEffect(() => {
    if (!open || !order) return;
    const seed: Record<string, LineDraft> = {};
    for (const line of order.lines) {
      if (line.outstanding_qty > 0) seed[line.id] = seedLineDraft(line);
    }
    setDrafts(seed);
    setReceivedAt(todayIso());
    setShowReauth(false);
    setSubmitting(false);
    setFormError(null);
    setErrorLineId(null);
  }, [open, order]);

  // Load the placement targets (all three areas) once when the dialog opens.
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
      .catch(() => {
        /* the picker shows an empty state if targets can't load */
      });
    return () => ctrl.abort();
  }, [open]);

  const patch = (lineId: string, p: Partial<LineDraft>) => {
    // Editing the line that failed clears the complaint about it.
    if (errorLineId === lineId) {
      setFormError(null);
      setErrorLineId(null);
    }
    setDrafts((prev) => {
      const existing = prev[lineId];
      if (!existing) return prev;
      return { ...prev, [lineId]: { ...existing, ...p } };
    });
  };

  const buildLines = ():
    | ReceiveEventLineInput[]
    | { error: string; lineId?: string } => {
    const out: ReceiveEventLineInput[] = [];
    // Track lot numbers already used per item so the same lot number can't be
    // typed twice for the SAME item across lines (backend enforces per-item
    // uniqueness; this is a friendly pre-check). The same lot number on
    // DIFFERENT items is allowed.
    const seenLotsByItem = new Map<string, Set<string>>();
    for (const line of outstandingLines) {
      const d = drafts[line.id];
      if (!d || !d.include) continue;
      const qty = Number(d.qty_received);
      if (!Number.isFinite(qty) || qty <= 0) {
        return {
          error: `Line ${line.line_no}: received qty must be greater than 0.`,
          lineId: line.id,
        };
      }
      const lotNumber = d.lot_number.trim();
      if (!lotNumber) {
        return {
          error: `Line ${line.line_no}: a lot number is required.`,
          lineId: line.id,
        };
      }
      const lotKey = lotNumber.toLowerCase();
      const seen = seenLotsByItem.get(line.item_id);
      if (seen?.has(lotKey)) {
        return {
          error: `Line ${line.line_no}: lot number "${lotNumber}" is already used for this item on another line. Use a different lot number per item.`,
          lineId: line.id,
        };
      }
      if (seen) seen.add(lotKey);
      else seenLotsByItem.set(line.item_id, new Set([lotKey]));
      if (
        d.manufacture_date &&
        d.expiration_date &&
        d.expiration_date < d.manufacture_date
      ) {
        return {
          error: `Line ${line.line_no}: expiration must be on or after manufacture date.`,
          lineId: line.id,
        };
      }
      let unitPrice: number | undefined;
      if (d.unit_price.trim() !== '') {
        const p = Number(d.unit_price);
        if (!Number.isFinite(p) || p < 0) {
          return {
            error: `Line ${line.line_no}: unit price must be non-negative.`,
            lineId: line.id,
          };
        }
        unitPrice = p;
      }
      if (!placementComplete(d.placement, qty)) {
        return {
          error:
            d.placement?.nodeType === 'box'
              ? `Line ${line.line_no}: select exactly ${qty} cell(s) in the chosen box.`
              : `Line ${line.line_no}: choose a destination location for the received units.`,
          lineId: line.id,
        };
      }
      out.push({
        line_id: line.id,
        qty_received: qty,
        lot_number: lotNumber,
        manufacture_date: d.manufacture_date || undefined,
        expiration_date: d.expiration_date || undefined,
        unit_price_amount: unitPrice,
        placement: {
          node_id: d.placement!.nodeId,
          cells: d.placement!.cells,
        },
      });
    }
    if (out.length === 0) {
      return { error: 'Include at least one line to receive.' };
    }
    return out;
  };

  const openSign = () => {
    setFormError(null);
    setErrorLineId(null);
    if (!receivedAt) {
      fail('A received date is required.');
      return;
    }
    const result = buildLines();
    if ('error' in result) {
      fail(result.error, result.lineId);
      return;
    }
    setShowReauth(true);
  };

  const submit = async (evidence: ReauthResponse) => {
    if (!order) return;
    const result = buildLines();
    if ('error' in result) {
      fail(result.error, result.lineId);
      return;
    }
    const payload: ReceiveEventInput = {
      received_at: receivedAt,
      lines: result,
      evidence_id: evidence.evidence_id,
    };
    setSubmitting(true);
    setFormError(null);
    setErrorLineId(null);
    try {
      const updated = await receivingApi.receive(order.id, payload);
      toast.success('Receipt recorded', {
        description: `${updated.po_reference} — ${result.length} line(s) received`,
      });
      onReceived(updated);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          setFormError('Your signature expired or was already used. Sign again.');
        } else {
          setFormError(err.message);
        }
      } else {
        setFormError('Failed to record the receipt. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const attestation = order
    ? `I attest the receipt recorded against order ${order.po_reference} is accurate.`
    : '';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Receive against order</DialogTitle>
            <DialogDescription>
              Record a dated receive event. Per line, enter the quantity and a new
              lot number. Partial receipts are allowed — skip a line or receive
              fewer than outstanding. Recorded under your e-signature.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="receive-date">
                  Received on <span className="text-danger">*</span>
                </Label>
                <Input
                  id="receive-date"
                  type="date"
                  value={receivedAt}
                  onChange={(e) => setReceivedAt(e.target.value)}
                />
              </div>
            </div>

            {outstandingLines.length === 0 && (
              <p className="text-sm text-text-3">
                Nothing outstanding to receive on this order.
              </p>
            )}

            {outstandingLines.map((line) => {
              const d = drafts[line.id];
              if (!d) return null;
              return (
                <div
                  key={line.id}
                  ref={(el) => {
                    lineRefs.current[line.id] = el;
                  }}
                  className={
                    errorLineId === line.id
                      ? 'rounded-md border border-danger bg-danger/5 p-3 ring-1 ring-danger/40'
                      : 'rounded-md border border-border bg-surface p-3'
                  }
                >
                  <div className="mb-2 flex items-center justify-between">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 rounded border-border-strong accent-accent"
                        checked={d.include}
                        onChange={(e) =>
                          patch(line.id, { include: e.target.checked })
                        }
                        aria-label={`Receive line ${line.line_no}`}
                      />
                      <span className="font-mono text-xs text-accent">
                        {line.item_number ?? '—'}
                      </span>
                      <span className="text-text-2">
                        {line.item_description ?? ''}
                      </span>
                    </label>
                    <span className="text-xs text-text-3">
                      outstanding {line.outstanding_qty} · {line.supplier_name ?? '—'}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <Label>Lot number</Label>
                      <Input
                        className="font-mono"
                        placeholder="L-20260629-A"
                        value={d.lot_number}
                        disabled={!d.include}
                        onChange={(e) =>
                          patch(line.id, { lot_number: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Qty received</Label>
                      <Input
                        type="number"
                        min={0}
                        step="1"
                        value={d.qty_received}
                        disabled={!d.include}
                        onChange={(e) =>
                          patch(line.id, { qty_received: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Unit price</Label>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="0.00"
                        value={d.unit_price}
                        disabled={!d.include}
                        onChange={(e) =>
                          patch(line.id, { unit_price: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Manufacture date</Label>
                      <Input
                        type="date"
                        value={d.manufacture_date}
                        disabled={!d.include}
                        onChange={(e) =>
                          patch(line.id, { manufacture_date: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Expiration date</Label>
                      <Input
                        type="date"
                        value={d.expiration_date}
                        disabled={!d.include}
                        onChange={(e) =>
                          patch(line.id, { expiration_date: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  {d.include && (
                    <div className="mt-3 space-y-1.5 border-t border-border pt-3">
                      <Label>
                        Destination — unit in <span className="text-danger">*</span>
                      </Label>
                      {trees ? (
                        <ReceiveLocationPicker
                          qty={Number(d.qty_received) || 0}
                          trees={trees}
                          value={d.placement}
                          onChange={(v) => patch(line.id, { placement: v })}
                        />
                      ) : (
                        <p className="text-xs text-text-3">Loading locations…</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

          </DialogBody>

          {/*
            Lives outside DialogBody on purpose: the body is the scroller, so an
            error rendered inside it lands off-screen and the button reads as
            dead. Here it sits against the footer, always in view.
          */}
          {formError && (
            <div
              role="alert"
              aria-live="assertive"
              className="flex items-start gap-2 border-t border-danger/30 bg-danger/5 px-5 py-3 text-xs text-danger"
            >
              <AlertCircle size={14} className="mt-px shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={openSign}
              disabled={submitting || outstandingLines.length === 0}
            >
              <ShieldCheck size={14} /> Sign &amp; receive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action="receipt.confirm"
        recordTable="app.receipt_transactions"
        recordId={order?.id}
        meaning={attestation}
        commentPlaceholder="e.g. Received against PO, lots verified against the packing slip"
        onConfirmed={submit}
        title="Sign this receipt"
        submitLabel="Sign & receive"
      />
    </>
  );
}
