'use client';

import * as React from 'react';
import { Truck } from 'lucide-react';

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
  SearchableSelect,
  type SearchableSelectOption,
} from '@/components/ui/searchable-select';
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import {
  LotSourcePicker,
  autoFillFifo,
  picksTotal,
  picksToSources,
  picksValid,
  type LotPick,
} from '@/components/reconciliation/lot-source-picker';
import { RejectedLotWarning } from '@/components/inventory/rejected-lot-warning';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import type { KitLineSourceLot } from '@/lib/api/kits';
import { shipmentsApi, type ShipSource } from '@/lib/api/shipments';
import { customersApi, type Customer } from '@/lib/api/customers';
import type { TierType } from '@/lib/api/tiers';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The built item being shipped — a finished good, or a sub-assembly sold
   *  directly (INV-004). ``tierType`` only shapes the wording. */
  item: { uuid: string; id: string; desc: string; tierType?: TierType | null } | null;
  onDone: () => void;
}

/** What to call the thing being shipped. A sub-assembly may be sold straight to
 *  a customer (INV-004), so the dialog can't call every shipment a finished
 *  good — it reads as the wrong item to whoever is signing. */
function tierNoun(tierType: TierType | null | undefined): string {
  return tierType === 'sub_assembly' ? 'sub-assembly' : 'finished good';
}

/** Map a shippable source to the shape the (reused) kitting lot picker expects. */
function toSourceLot(s: ShipSource): KitLineSourceLot {
  return {
    lot_id: s.lot_id,
    lot_number: s.lot_number,
    release_state: s.release_state,
    expiration_date: s.expiration_date,
    node_id: s.node_id,
    node_name: s.location,
    path: s.location,
    qty: s.qty,
    is_grid: s.is_grid,
    grid_rows: s.grid_rows,
    grid_cols: s.grid_cols,
    cells: s.cells,
  };
}

/**
 * Ship a finished good out to a customer — the terminal transaction
 * (CUST-001 / TRX-005). Source selection reuses the kitting Issue picker, so a
 * shipment can draw from **several lots / locations** (and pick exact LN2 vials).
 * A named customer and a reference / tracking number are required. E-signed
 * (``movement.customer_shipment``).
 */
export function ShipToCustomerDialog({ open, onOpenChange, item, onDone }: Props) {
  const [lots, setLots] = React.useState<KitLineSourceLot[] | null>(null);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [picks, setPicks] = React.useState<LotPick[]>([]);
  const [customerSel, setCustomerSel] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setLots(null);
    setPicks([]);
    setCustomerSel('');
    setReference('');
    setShowReauth(false);
    setSubmitting(false);
    setError(null);
  }, [open, item]);

  React.useEffect(() => {
    if (!open || !item) return;
    const ctrl = new AbortController();
    Promise.all([
      shipmentsApi.sources(item.uuid, { signal: ctrl.signal }),
      customersApi.list({}, { signal: ctrl.signal }),
    ])
      .then(([src, custs]) => {
        const mapped = src.map(toSourceLot);
        setLots(mapped);
        setCustomers(custs);
        // Seed one blank pick row (there is no fixed target — the operator
        // decides how much to ship).
        setPicks(autoFillFifo(mapped, 0));
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError('Failed to load shippable stock.');
      });
    return () => ctrl.abort();
  }, [open, item]);

  const total = picksTotal(picks);
  const noStock = lots !== null && lots.length === 0;
  const picksOk = lots !== null && total >= 1 && picksValid(lots, picks);

  /**
   * Rejected batches among the picked sources (STS-003, client 2026-08-17).
   *
   * A warning, not a gate — the client was explicit that the status is a record
   * in this version. It matters most here of all the outbound flows: a rejected
   * batch reaching a customer is a different order of mistake from one moving
   * between freezers.
   */
  const rejectedLots = React.useMemo(() => {
    const names = new Set<string>();
    for (const p of picks) {
      if (!p.lot_id) continue;
      const src = lots?.find((l) => l.lot_id === p.lot_id && l.node_id === p.node_id);
      if (src?.release_state === 'rejected') names.add(src.lot_number ?? p.lot_id.slice(0, 8));
    }
    return [...names];
  }, [picks, lots]);

  const customerOptions: SearchableSelectOption[] = React.useMemo(
    () =>
      customers.map((c) => ({
        value: c.id,
        label: c.name,
        searchText: `${c.name} ${c.contact_person ?? ''} ${c.email ?? ''}`,
      })),
    [customers],
  );

  const noun = tierNoun(item?.tierType);
  const noStockMessage = `No ${noun} stock is available to ship.`;

  const validate = (): string | null => {
    if (!lots || lots.length === 0) return noStockMessage;
    if (total < 1) return 'Pick at least one lot and quantity to ship.';
    if (!picksValid(lots, picks)) return 'One or more picks exceed the available quantity.';
    if (!customerSel) return 'Choose a customer.';
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
    setSubmitting(true);
    setError(null);
    try {
      const shipment = await shipmentsApi.ship({
        sources: picksToSources(picks),
        customer_id: customerSel,
        reference_number: reference.trim() || null,
        evidence_id: evidence.evidence_id,
        notes: evidence.comment ?? '',
      });
      toast.success('Shipment recorded', {
        description: `${shipment.total_qty} unit${
          shipment.total_qty === 1 ? '' : 's'
        } shipped to ${shipment.customer_name}`,
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
        setError('Failed to record the shipment. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const customerLabel =
    customers.find((c) => c.id === customerSel)?.name ?? 'the customer';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Ship to customer</DialogTitle>
            <DialogDescription>
              Ship <span className="font-medium">{item?.desc}</span> out of inventory. This
              is the {noun}&apos;s terminal transaction.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {noStock ? (
              <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text-2">
                {noStockMessage}
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>Ship from (add a lot per location)</Label>
                  {lots === null ? (
                    <p className="text-xs text-text-3">Loading available stock…</p>
                  ) : (
                    <LotSourcePicker
                      modal
                      itemNumber={item?.id ?? ''}
                      lots={lots}
                      needed={0}
                      picks={picks}
                      onChange={setPicks}
                    />
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="ship-customer">
                    Customer <span className="text-danger">*</span>
                  </Label>
                  <SearchableSelect
                    id="ship-customer"
                    modal
                    options={customerOptions}
                    value={customerSel}
                    onChange={setCustomerSel}
                    placeholder="Select a customer…"
                    searchPlaceholder="Search customers…"
                    emptyText="No customers yet — add one on the Customers page."
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="ship-ref">Reference / tracking number</Label>
                  <Input
                    id="ship-ref"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="e.g. SO-10432 or a shipping tracking number"
                    maxLength={256}
                  />
                  <p className="text-xs text-text-3">
                    Optional — a sales-order or tracking number for this shipment.
                  </p>
                </div>
              </>
            )}

            <RejectedLotWarning lotNumbers={rejectedLots} action="ship it" />

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
            <Button
              type="button"
              variant="primary"
              onClick={openSign}
              disabled={submitting || noStock || !picksOk || !customerSel}
            >
              <Truck size={14} /> Sign &amp; ship
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action="movement.customer_shipment"
        recordTable="app.items"
        recordId={item?.uuid}
        meaning={`I am shipping ${total} unit(s) of ${item?.desc ?? 'this finished good'} to ${customerLabel}.`}
        commentPlaceholder="e.g. Shipped against sales order SO-10432"
        onConfirmed={submit}
        title="Sign this shipment"
        submitLabel="Sign & ship"
      />
    </>
  );
}
