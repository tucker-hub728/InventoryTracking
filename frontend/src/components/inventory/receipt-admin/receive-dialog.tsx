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

/** Mirrors ``SYNTHETIC_LOT_PREFIX`` in backend/app/inventory/repository.py.
 *  A wire-format constant rather than shared code, so it is kept in sync by
 *  hand; the server rejects the prefix too, so a drift here is a worse error
 *  message, not a hole. */
const AUTO_LOT_PREFIX = 'AUTO-';

interface LineDraft {
  include: boolean;
  /** In ORDER units — what the receiver types, e.g. 3 (boxes). NOT the number
   *  of units placed; see `placedUnits` (REQ-001). */
  qty_received: string;
  lot_number: string;
  manufacture_date: string;
  expiration_date: string;
  /** Per ORDER unit, like the order line's — the price of one box. */
  unit_price: string;
  /** The pack, editable here (REQ-001). Seeded from the Order line, but the
   *  receiver may set one the PO never had, or correct a wrong one — the dock
   *  is where anyone actually knows what a box holds. Both blank = the line is
   *  counted in consume units. */
  pack_uom: string;
  units_per_pack: string;
  /** Where the received units go (unit-in) — chosen in the same signed step. */
  placement: PlacementValue | null;
}

function seedLineDraft(line: OrderLine): LineDraft {
  return {
    include: false,
    // Already in order units — outstanding_qty and qty_received are the same
    // unit, which is why this pre-fill needs no conversion.
    qty_received: String(line.outstanding_qty),
    lot_number: '',
    manufacture_date: '',
    expiration_date: '',
    unit_price: line.unit_price_amount ?? '',
    pack_uom: line.pack_uom ?? '',
    units_per_pack: line.units_per_pack == null ? '' : String(line.units_per_pack),
    placement: null,
  };
}

/** The pack size in force for this draw — whatever is in the draft, since the
 *  receiver may have set or corrected it. Null when no order unit is named, or
 *  when the size is not yet a usable number. */
function effectivePackSize(d: LineDraft): number | null {
  if (!d.pack_uom.trim()) return null;
  const typed = Number(d.units_per_pack);
  return Number.isInteger(typed) && typed > 0 ? typed : null;
}

/** CONSUME units this draw will actually place — the figure the location
 *  picker, the cell count and the capacity check all need.
 *
 *  This is deliberately a separate function from reading `qty_received`. The
 *  two were one variable before REQ-001 and were correct that way; now they
 *  differ by a factor of the pack size, and every site has to say which one it
 *  means. Returns 0 when the pack size is still unknown, so the UI blocks on
 *  "enter the units per box" rather than silently placing 3.
 */
function placedUnits(d: LineDraft): number {
  const packs = Number(d.qty_received);
  if (!Number.isInteger(packs) || packs <= 0) return 0;
  if (!d.pack_uom.trim()) return packs;
  const size = effectivePackSize(d);
  return size == null ? 0 : packs * size;
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

  /** Cells in ``nodeId`` that OTHER lines of this same receipt already aim at,
   *  as ``"row:col"`` keys. One delivery routinely puts several lines into one
   *  LN2 box, and until the receipt is signed no claim exists on the server —
   *  so without this two lines can both choose A1 and only collide at submit.
   *  The transfer dialog and kitting close-out both already guard this. */
  const cellsClaimedByOtherLines = (lineId: string, nodeId: string | undefined) => {
    const claimed = new Set<string>();
    if (!nodeId) return claimed;
    for (const [id, d] of Object.entries(drafts)) {
      if (id === lineId || !d.include || d.placement?.nodeId !== nodeId) continue;
      for (const c of d.placement.cells) claimed.add(`${c.grid_row}:${c.grid_col}`);
    }
    return claimed;
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
      // `qty` is what the receiver typed (ORDER units, e.g. 3 boxes).
      // `units` is what physically lands in the location (CONSUME units, 300).
      // They differ by the pack size and are NOT interchangeable — the payload
      // wants the first, every placement check wants the second.
      const qty = Number(d.qty_received);
      if (!Number.isFinite(qty) || qty <= 0) {
        return {
          error: `Line ${line.line_no}: received qty must be greater than 0.`,
          lineId: line.id,
        };
      }
      if (!Number.isInteger(qty)) {
        return {
          error: `Line ${line.line_no}: received qty must be a whole number.`,
          lineId: line.id,
        };
      }
      const packUom = d.pack_uom.trim();
      const packSizeRaw = d.units_per_pack.trim();
      if (packUom && !packSizeRaw) {
        return {
          error: `Line ${line.line_no}: enter how many units are in one ${packUom}.`,
          lineId: line.id,
        };
      }
      if (packSizeRaw && !packUom) {
        return {
          error: `Line ${line.line_no}: enter an order unit (e.g. Box), or clear the units per unit.`,
          lineId: line.id,
        };
      }
      const packSize = effectivePackSize(d);
      if (packUom && packSize == null) {
        return {
          error: `Line ${line.line_no}: units per ${packUom} must be a whole number above 0.`,
          lineId: line.id,
        };
      }
      const units = placedUnits(d);
      // ── Lot control (REQ-003) ─────────────────────────────────────
      // Never required (REQ-003): any item may be received without a lot
      // number, and the server synthesizes one when it is blank. Deliberately
      // left empty rather than pre-filled here — the client must not invent an
      // identifier that ends up in a GxP record.
      const lotNumber = d.lot_number.trim();
      if (lotNumber.toUpperCase().startsWith(AUTO_LOT_PREFIX)) {
        // Mirrors the server rule. The prefix is how every later reader tells a
        // generated number from a supplier's; a typed one would break that.
        return {
          error: `Line ${line.line_no}: "${AUTO_LOT_PREFIX}" is reserved for numbers the system generates. Enter the supplier's lot number, or leave it blank.`,
          lineId: line.id,
        };
      }
      // Only a real number can collide — two blanks on the same item become
      // two different generated numbers, so they are not duplicates.
      if (lotNumber) {
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
      }
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
      // Placement is unit-by-unit, so this is measured in CONSUME units: a box
      // receiving 3 packs of 100 needs 300 free cells, not 3.
      if (!placementComplete(d.placement, units)) {
        return {
          error:
            d.placement?.nodeType === 'box'
              ? `Line ${line.line_no}: select exactly ${units} cell(s) in the chosen box.`
              : `Line ${line.line_no}: choose a destination location for the received units.`,
          lineId: line.id,
        };
      }
      out.push({
        line_id: line.id,
        // ORDER units — the server multiplies. Sending `units` here would
        // record 300 boxes received against a 3-box line.
        qty_received: qty,
        // Blank means "synthesize one" (REQ-003) — send null rather than "",
        // so the intent is explicit on the wire.
        lot_number: lotNumber || null,
        manufacture_date: d.manufacture_date || undefined,
        expiration_date: d.expiration_date || undefined,
        unit_price_amount: unitPrice,
        // Sent whenever it differs from the line, so the receiver can set a
        // pack the PO never had or correct a wrong one. The server writes it
        // back to the line.
        pack_uom: packUom || null,
        units_per_pack: packSize ?? null,
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
                      outstanding {line.outstanding_qty}
                      {line.pack_uom ? ` ${line.pack_uom}` : ''}
                      {/* The units figure is server-computed; it is null-safe to
                          show only when the pack size is actually known. */}
                      {line.pack_uom && line.units_per_pack != null
                        ? ` (${line.outstanding_units.toLocaleString()} units)`
                        : ''}{' '}
                      · {line.supplier_name ?? '—'}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <Label>Lot number</Label>
                      <Input
                        className="font-mono"
                        // No asterisk and no example lot number: the field is
                        // optional for every item (REQ-003), and an example
                        // here would read as an instruction to make one up.
                        // The placeholder says what happens if you do nothing.
                        placeholder="Optional — generated if blank"
                        value={d.lot_number}
                        disabled={!d.include}
                        onChange={(e) =>
                          patch(line.id, { lot_number: e.target.value })
                        }
                      />
                      {!d.lot_number.trim() && d.include && (
                        <p className="text-[11px] text-text-3">
                          A tracking number will be generated.
                        </p>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label>
                        Qty received
                        {d.pack_uom.trim() ? ` (${d.pack_uom.trim()})` : ''}
                      </Label>
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
                      <Label>Order unit</Label>
                      <Input
                        placeholder="Each"
                        value={d.pack_uom}
                        disabled={!d.include}
                        onChange={(e) =>
                          patch(line.id, { pack_uom: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  {/* The pack and its price. Always shown and always editable:
                      the PO is a plan, and the receiver is the first person who
                      can see what a box actually holds. What they enter is
                      written back to the order line. */}
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>
                        {d.pack_uom.trim()
                          ? `Units per ${d.pack_uom.trim()}`
                          : 'Units per unit'}
                        {d.pack_uom.trim() && (
                          <span className="text-danger"> *</span>
                        )}
                      </Label>
                      <Input
                        type="number"
                        min={1}
                        step="1"
                        placeholder={d.pack_uom.trim() ? '100' : '—'}
                        value={d.units_per_pack}
                        // Meaningless until there is a unit to be a count OF.
                        disabled={!d.include || !d.pack_uom.trim()}
                        onChange={(e) =>
                          patch(line.id, { units_per_pack: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>
                        Unit price
                        {d.pack_uom.trim() ? ` per ${d.pack_uom.trim()}` : ''}
                      </Label>
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

                  {/* Restates the arithmetic in the operator's terms, right
                      above the destination picker that consumes it. */}
                  {d.pack_uom.trim() && placedUnits(d) > 0 && (
                    <p className="mt-2 text-xs text-text-3">
                      {d.qty_received} {d.pack_uom.trim()} ×{' '}
                      {effectivePackSize(d)} ={' '}
                      <span className="font-medium text-text-2">
                        {placedUnits(d).toLocaleString()} units
                      </span>{' '}
                      to place
                      {d.unit_price.trim() !== '' &&
                        Number(d.unit_price) >= 0 &&
                        effectivePackSize(d) && (
                          <>
                            {' · $'}
                            {(Number(d.unit_price) / effectivePackSize(d)!)
                              .toFixed(6)
                              .replace(/\.?0+$/, '')}{' '}
                            per unit
                          </>
                        )}
                    </p>
                  )}

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
                          // CONSUME units, not the typed pack count — this
                          // drives the cell grid, the capacity check and the
                          // "All N units will be placed" copy.
                          qty={placedUnits(d)}
                          trees={trees}
                          value={d.placement}
                          onChange={(v) => patch(line.id, { placement: v })}
                          reservedCells={cellsClaimedByOtherLines(
                            line.id,
                            d.placement?.nodeId,
                          )}
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
