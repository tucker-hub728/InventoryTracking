'use client';

import * as React from 'react';
import { ArrowLeft, Scale, ShieldCheck } from 'lucide-react';

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
import { LocationPath } from '@/components/locations/location-path';
import {
  useStockAdjust,
  type AdjustTarget,
} from '@/components/inventory/stock-adjust-dialog';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import { itemsApi, type ApiItemSupplier } from '@/lib/api/items';
import { locationNodesApi, type Allocation } from '@/lib/api/location-nodes';
import { lotsApi, type Lot, type LotUpdateInput } from '@/lib/api/lots';
import { formatNumber, priceInputValue } from '@/lib/utils';

interface Props {
  /** Lot to edit; when null the dialog is closed. */
  lotId: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/** One place this lot is stored, and how much of it is there. */
interface Placement {
  node_id: string;
  /** Leaf name; ``LocationPath`` draws the ancestry around it. */
  location: string;
  qty: number;
  is_grid: boolean;
}

/** Node types that may hold an allocation — mirrors the backend's
 *  ``STORAGE_NODE_TYPES`` / ``can_store``. The other thing a lot's allocations
 *  point at is a production floor holding an open kit's WIP, and that is not
 *  somewhere a counting correction belongs: it comes back through the kit's
 *  Return step, and ``/allocations/adjust`` would refuse the node anyway
 *  (``node_not_storable``). Filtering here means the operator is never offered
 *  a button that cannot work. */
const STORABLE_NODE_TYPES = new Set(['box', 'sub_location', 'shelf']);

/**
 * Collapse a lot's allocation rows into one row per location.
 *
 * A box carries one unit per position, so a lot with 40 vials in one box is 40
 * allocation rows. The operator thinks in "40 in Box 5", and that is also the
 * grain ``/allocations/adjust`` works at, so the sum is the honest unit here.
 */
function groupPlacements(rows: Allocation[]): Placement[] {
  const byNode = new Map<string, Placement>();
  for (const a of rows) {
    if (!a.location_node_type || !STORABLE_NODE_TYPES.has(a.location_node_type)) {
      continue;
    }
    const found = byNode.get(a.location_node_id);
    if (found) {
      found.qty += a.qty;
    } else {
      byNode.set(a.location_node_id, {
        node_id: a.location_node_id,
        location: a.location_name ?? 'Unknown location',
        qty: a.qty,
        is_grid: a.location_node_type === 'box',
      });
    }
  }
  return [...byNode.values()].sort((x, y) => x.location.localeCompare(y.location));
}

/**
 * E-signed edit of a lot's correctable attributes — supplier, manufacture /
 * expiration dates and unit price. ``lot_number`` and the parent item stay
 * immutable identity. Supplier choices are restricted to the item's assigned
 * suppliers. Every save consumes a fresh reauth ticket minted for
 * ``lot.update`` and records the optional reason (the e-signature comment).
 *
 * ``ordered_qty`` is shown but not editable here — a counting discrepancy is
 * corrected where it happened, by the per-location **Adjust** action in the
 * "Placed at" list below, so it carries a location and a signed ledger row
 * (CTL-002). The API still accepts the field (its guards are documented on
 * ``update_lot``); this dialog simply is not the door.
 *
 * The correction lives here, beside the arrival figure it is reconciled
 * against, because this is the screen an operator opens when the paperwork and
 * the shelf disagree. It cannot be a *field* on this form, though: a lot can be
 * in several places at once and the ledger row has to name one. So it is a row
 * action per (lot × location), and each correction carries its OWN signature —
 * "Sign & save" signs the attribute edits above and nothing else. Folding two
 * verbs into one reauth ticket would spend it twice.
 *
 * Adjust opens as a *view* of this dialog rather than a dialog on top of it:
 * the correction already has to raise the e-signature prompt, and a third
 * stacked layer is where a modal stops being navigable. The header grows a
 * back arrow, the body swaps, and Escape steps back one view instead of
 * discarding the edit underneath.
 */
export function LotDetailEditDialog({ lotId, onOpenChange, onSaved }: Props) {
  const open = lotId !== null;

  const [lot, setLot] = React.useState<Lot | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [itemSuppliers, setItemSuppliers] = React.useState<ApiItemSupplier[]>([]);
  const [supplierId, setSupplierId] = React.useState('');
  const [unitPrice, setUnitPrice] = React.useState('');
  const [qtyReceived, setQtyReceived] = React.useState('');
  const [mfgDate, setMfgDate] = React.useState('');
  const [expDate, setExpDate] = React.useState('');
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [placements, setPlacements] = React.useState<Placement[]>([]);
  const [placementsLoading, setPlacementsLoading] = React.useState(false);
  /** Bumped after a correction posts, to re-read the list under it. */
  const [placementsSeq, setPlacementsSeq] = React.useState(0);
  /** The (lot × location) being corrected, or null. */
  const [adjustTarget, setAdjustTarget] = React.useState<AdjustTarget | null>(
    null,
  );
  /** True once a correction has posted. The page behind this dialog is then
   *  stale even if the operator never touches "Sign & save", so closing has to
   *  refresh rather than merely dismiss. */
  const [adjusted, setAdjusted] = React.useState(false);
  // A correction is a signed movement in its own right, gated on the same
  // permission the save is — ``read_only`` holds neither.
  const canSign = usePermission('inventory', 'sign');

  // The correction form, borrowed from the standalone dialog so the cap, the
  // cell shapes and the ledger note stay defined in exactly one place.
  const adjust = useStockAdjust({
    target: adjustTarget,
    onDone: () => {
      setAdjusted(true);
      setPlacementsSeq((n) => n + 1);
      // Straight back to the lot, where the list now shows the new number.
      setAdjustTarget(null);
    },
  });

  // Fetch the lot (+ its item's suppliers) whenever a lot id is opened.
  React.useEffect(() => {
    if (!lotId) {
      setLot(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setFormError(null);
    setShowReauth(false);
    setSubmitting(false);
    setItemSuppliers([]);
    setAdjusted(false);

    lotsApi
      .get(lotId, { signal: ctrl.signal })
      .then((fetched) => {
        setLot(fetched);
        setSupplierId(fetched.supplier_id ?? '');
        // Trimmed, not raw: NUMERIC(14, 6) returns "0.000000" for a price
        // typed as "0", and six zeros nobody entered read as the system having
        // decided something.
        setUnitPrice(priceInputValue(fetched.unit_price_amount));
        setQtyReceived(
          fetched.ordered_qty != null ? String(fetched.ordered_qty) : '',
        );
        setMfgDate(fetched.manufacture_date ?? '');
        setExpDate(fetched.expiration_date ?? '');
        return itemsApi
          .listSuppliers(fetched.item_id, { signal: ctrl.signal })
          .then(setItemSuppliers)
          .catch(() => setItemSuppliers([]));
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setFormError(
          err instanceof ApiError ? err.message : 'Failed to load lot.',
        );
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [lotId]);

  // Where the lot physically is. A separate fetch from the lot itself because
  // a correction re-reads only this half, and because failing to load it must
  // not block editing the attributes above — it degrades to an empty list.
  React.useEffect(() => {
    if (!lotId) {
      setPlacements([]);
      return;
    }
    const ctrl = new AbortController();
    setPlacementsLoading(true);
    locationNodesApi
      .lotAllocations(lotId, { signal: ctrl.signal })
      .then((rows) => setPlacements(groupPlacements(rows)))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setPlacements([]);
      })
      .finally(() => setPlacementsLoading(false));

    return () => ctrl.abort();
  }, [lotId, placementsSeq]);

  // The supplier dropdown is the item's assigned suppliers. If the lot's current
  // supplier somehow isn't in that list, surface it so it still shows / can be
  // kept (only off-list *changes* are rejected by the backend).
  const supplierOptions = React.useMemo<ApiItemSupplier[]>(() => {
    if (
      lot?.supplier_id &&
      !itemSuppliers.some((v) => v.supplier_id === lot.supplier_id)
    ) {
      return [
        { supplier_id: lot.supplier_id, supplier_name: lot.supplier_name ?? '(current)' },
        ...itemSuppliers,
      ];
    }
    return itemSuppliers;
  }, [itemSuppliers, lot]);

  // Resolve only the changed fields into a patch (excluding evidence/reason).
  // Returns null (and sets an error) when invalid or empty.
  const resolvePatch = (): Omit<
    LotUpdateInput,
    'evidence_id' | 'reason'
  > | null => {
    if (!lot) return null;
    const patch: Omit<LotUpdateInput, 'evidence_id' | 'reason'> = {};

    if (supplierId && supplierId !== (lot.supplier_id ?? '')) {
      patch.supplier_id = supplierId;
    }
    const mfg = mfgDate || null;
    if (mfg !== (lot.manufacture_date ?? null)) patch.manufacture_date = mfg;
    const exp = expDate || null;
    if (exp !== (lot.expiration_date ?? null)) patch.expiration_date = exp;

    // Compared as a NUMBER, not as text. The field is seeded with the trimmed
    // spelling, so a string compare against the raw stored value would call an
    // untouched "0" different from "0.000000" and patch the price on every save.
    const enteredPrice = unitPrice.trim();
    const storedPrice = lot.unit_price_amount;
    const priceChanged =
      enteredPrice === ''
        ? storedPrice != null
        : storedPrice == null || Number(enteredPrice) !== Number(storedPrice);
    if (priceChanged) {
      if (enteredPrice === '') {
        patch.unit_price_amount = null;
      } else {
        const p = Number(enteredPrice);
        if (!Number.isFinite(p) || p < 0) {
          setFormError('Unit price must be a non-negative number.');
          return null;
        }
        patch.unit_price_amount = p;
      }
    }

    const currentQty = lot.ordered_qty != null ? String(lot.ordered_qty) : '';
    if (qtyReceived.trim() !== currentQty) {
      const q = Number(qtyReceived);
      if (!Number.isInteger(q) || q < 1) {
        setFormError('Qty received must be a whole number of at least 1.');
        return null;
      }
      patch.ordered_qty = q;
    }

    if (Object.keys(patch).length === 0) {
      setFormError('No changes to save.');
      return null;
    }
    if (mfg && exp && exp < mfg) {
      setFormError('Expiration date must be on or after the manufacture date.');
      return null;
    }
    return patch;
  };

  const openSign = () => {
    setFormError(null);
    if (resolvePatch() === null) return;
    setShowReauth(true);
  };

  const submit = async (evidence: ReauthResponse) => {
    if (!lot) return;
    const patch = resolvePatch();
    if (patch === null) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const updated = await lotsApi.update(lot.id, {
        ...patch,
        evidence_id: evidence.evidence_id,
        reason: evidence.comment ?? undefined,
      });
      toast.success('Lot updated', { description: updated.lot_number });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          setFormError('Your signature expired or was already used. Sign again.');
        } else if (err.code === 'qty_below_placed') {
          // Helpful sentence from the backend: remove the lot from its
          // location(s) before lowering the received quantity.
          setFormError(err.message);
        } else {
          setFormError(err.message);
        }
      } else {
        setFormError('Failed to update lot. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  /** Dismiss. A posted correction leaves through ``onSaved`` — the same
   *  refresh a field edit asks for — because the totals and the ledger behind
   *  this dialog have moved. */
  const close = React.useCallback(() => {
    if (adjusted) onSaved();
    else onOpenChange(false);
  }, [adjusted, onSaved, onOpenChange]);

  const openAdjust = (place: Placement) => {
    if (!lot) return;
    setAdjustTarget({
      lot_id: lot.id,
      lot_number: lot.lot_number,
      node_id: place.node_id,
      location: place.location,
      qty: place.qty,
      is_grid: place.is_grid,
    });
  };

  const placedTotal = placements.reduce((n, place) => n + place.qty, 0);

  const meaning = lot
    ? `I am correcting lot ${lot.lot_number}'s details.`
    : '';

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) close();
        }}
      >
        <DialogContent
          // An LN2 box needs room for its grid; the lot's own fields do not.
          className={adjustTarget?.is_grid ? 'max-w-2xl' : 'max-w-md'}
          // Escape is "back" while correcting — the lot edit underneath is
          // half-typed, and losing it to a stray keypress is the kind of thing
          // that makes people stop trusting a form.
          onEscapeKeyDown={(e) => {
            if (!adjustTarget) return;
            e.preventDefault();
            if (!adjust.submitting) setAdjustTarget(null);
          }}
        >
          {adjustTarget ? (
            <DialogHeader>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  aria-label="Back to lot details"
                  onClick={() => setAdjustTarget(null)}
                  disabled={adjust.submitting}
                >
                  <ArrowLeft size={14} />
                </Button>
                <DialogTitle>Adjust · {adjustTarget.location}</DialogTitle>
              </div>
              <DialogDescription>
                <span className="font-mono text-accent">
                  {adjustTarget.lot_number ?? '—'}
                </span>{' '}
                · recorded here: {formatNumber(adjustTarget.qty)}. This corrects
                what is at this location, not what was received. Signed
                separately from the lot&rsquo;s details.
              </DialogDescription>
            </DialogHeader>
          ) : (
            <DialogHeader>
              <DialogTitle>Edit lot</DialogTitle>
              <DialogDescription>
                {lot ? (
                  <>
                    <span className="font-mono text-accent">{lot.lot_number}</span>{' '}
                    · Supplier, dates and unit price. The lot number and the
                    received quantity are fixed — to correct a count, use Adjust
                    on the location holding it. Recorded under your e-signature.
                  </>
                ) : (
                  'Loading lot…'
                )}
              </DialogDescription>
            </DialogHeader>
          )}

          {adjustTarget ? (
            <DialogBody>{adjust.fields}</DialogBody>
          ) : (
            <DialogBody className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="lot-detail-edit-number">Lot number</Label>
                <Input
                  id="lot-detail-edit-number"
                  className="font-mono"
                  value={lot?.lot_number ?? ''}
                  disabled
                  title="The lot number is immutable"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="lot-detail-edit-supplier">Supplier</Label>
                <Select
                  value={supplierId}
                  onValueChange={setSupplierId}
                  disabled={!lot || loading}
                >
                  <SelectTrigger id="lot-detail-edit-supplier">
                    <SelectValue placeholder="Select supplier" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {supplierOptions.map((v) => (
                      <SelectItem key={v.supplier_id} value={v.supplier_id}>
                        {v.supplier_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="lot-detail-edit-qty">Qty received</Label>
                  <Input
                    id="lot-detail-edit-qty"
                    type="number"
                    inputMode="numeric"
                    step="1"
                    min={1}
                    value={qtyReceived}
                    // Read-only, like the lot number above it — restored 2026-08-28
                    // after a day spent editable.
                    //
                    // The number here is what ARRIVED, and it is the cap every
                    // placement path measures against. The discrepancy an operator
                    // actually wants to fix is almost never this: it is that the
                    // shelf holds 58 where the record says 60. That belongs to the
                    // (lot × location) it happened at, where it can carry a
                    // location and a signed ledger row — the Adjust action in the
                    // "Placed at" list below (CTL-002). Editing the arrival figure
                    // here would move a number nothing physical backs, and could
                    // not say where the units went.
                    disabled
                    readOnly
                    title="Set at receipt — correct a counting discrepancy with Adjust, in the list below"
                    onChange={(e) => setQtyReceived(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lot-detail-edit-price">Unit price</Label>
                  <Input
                    id="lot-detail-edit-price"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min={0}
                    value={unitPrice}
                    disabled={!lot || loading}
                    onChange={(e) => setUnitPrice(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="lot-detail-edit-mfg">Manufacture date</Label>
                  <Input
                    id="lot-detail-edit-mfg"
                    type="date"
                    value={mfgDate}
                    disabled={!lot || loading}
                    onChange={(e) => setMfgDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lot-detail-edit-exp">Expiration date</Label>
                  <Input
                    id="lot-detail-edit-exp"
                    type="date"
                    value={expDate}
                    disabled={!lot || loading}
                    onChange={(e) => setExpDate(e.target.value)}
                  />
                </div>
              </div>

              {/* Where the lot actually is, and the door to correcting it
                  (CTL-002). Read-only quantities: the number moves by a signed
                  ``adjustment`` movement, never by typing over it. */}
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label>Placed at</Label>
                  {placements.length > 0 && (
                    <span className="text-[11px] text-text-2">
                      {formatNumber(placedTotal)} in {placements.length}{' '}
                      {placements.length === 1 ? 'location' : 'locations'}
                    </span>
                  )}
                </div>

                {placementsLoading ? (
                  <p className="px-0.5 text-xs text-text-2">Loading locations…</p>
                ) : placements.length === 0 ? (
                  <p className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-2">
                    None of this lot is in a storage location, so there is no
                    balance to correct. Receive it to inventory first.
                  </p>
                ) : (
                  <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
                    {placements.map((place) => (
                      <li
                        key={place.node_id}
                        className="flex items-center justify-between gap-3 px-3 py-2"
                      >
                        <div className="min-w-0 text-xs">
                          <LocationPath
                            nodeId={place.node_id}
                            name={place.location}
                            onNavigate={close}
                          />
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="tabular-nums text-xs text-text-2">
                            {formatNumber(place.qty)}
                          </span>
                          <Button
                            size="sm"
                            type="button"
                            disabled={!canSign || submitting}
                            aria-label={`Adjust ${lot?.lot_number ?? 'stock'} at ${place.location}`}
                            title={
                              canSign
                                ? 'Correct what is actually here — signed separately'
                                : 'Correcting a balance needs permission to sign'
                            }
                            onClick={() => openAdjust(place)}
                          >
                            <Scale size={13} /> Adjust
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {formError && (
                <p
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
                >
                  {formError}
                </p>
              )}
            </DialogBody>
          )}

          {adjustTarget ? (
            <DialogFooter>
              <Button
                type="button"
                onClick={() => setAdjustTarget(null)}
                disabled={adjust.submitting}
              >
                <ArrowLeft size={14} /> Back
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={adjust.openSign}
                disabled={adjust.submitting}
              >
                <Scale size={14} /> Sign &amp; adjust
              </Button>
            </DialogFooter>
          ) : (
            <DialogFooter>
              <Button type="button" onClick={close} disabled={submitting}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={openSign}
                disabled={submitting || !lot || loading}
              >
                <ShieldCheck size={14} /> Sign &amp; save
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Its own signature, its own reason, its own ledger row — see the
          component docstring for why this is not part of "Sign & save". This
          is the ONE layer that has to stack: an e-signature is a dialog. */}
      {adjust.reauth}

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action="lot.update"
        recordTable="app.lots"
        recordId={lotId ?? undefined}
        meaning={meaning}
        commentPlaceholder="e.g. Corrected expiration date from the CoA"
        onConfirmed={submit}
        title="Sign this lot edit"
        submitLabel="Sign & save"
      />
    </>
  );
}
