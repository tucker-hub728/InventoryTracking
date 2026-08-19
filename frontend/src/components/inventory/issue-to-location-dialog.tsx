'use client';

import * as React from 'react';
import { Check, MapPin, MinusCircle, Truck } from 'lucide-react';

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
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import type { KitLineSourceLot } from '@/lib/api/kits';
import {
  MATERIAL_ISSUE_ACTION,
  issuesApi,
  type IssueDestination,
  type IssueSource,
} from '@/lib/api/issues';
import { customersApi, type Customer } from '@/lib/api/customers';
import { shipmentsApi } from '@/lib/api/shipments';

/** Where material can go when it leaves inventory (REQ-2026-07-31-TRX-001).
 *
 *  One control, two terminal transactions — deliberately not one transaction
 *  with two flavours. A customer shipment carries a customer and a reference
 *  number and is the terminal event for a product (REQ-2026-07-09-TRX-001); an
 *  issue to a lab carries neither and simply ends the material's life in the
 *  system. Merging their LEDGERS would cost CUST-001 its requirement that the
 *  movement names the customer, so what is unified here is the operator's entry
 *  point, not the record.
 */
type DestinationKind = 'location' | 'customer';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The item being issued. Any item may be issued to an internal location;
   *  ``isConsumable`` is carried because a consumable cannot go to a CUSTOMER
   *  (it is consumed on issue and has no balance left to ship), and the dialog
   *  has to say so BEFORE the operator signs rather than failing afterwards. */
  item: { uuid: string; id: string; desc: string; isConsumable?: boolean } | null;
  onDone: () => void;
}

/** Map an issuable source to the shape the (reused) kitting lot picker expects.
 *
 *  The grid fields are carried through rather than blanked: a lot being issued
 *  may well sit in an LN2 box (client 2026-08-11), and flattening that to a
 *  plain number box would hide the very grid kitting shows for the same lot and
 *  let the backend empty the wrong vials. */
function toSourceLot(s: IssueSource): KitLineSourceLot {
  return {
    lot_id: s.lot_id,
    lot_number: s.lot_number,
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
 * Issue material to a location — debit-and-gone (REQ-2026-08-04-TRX-001/002).
 *
 * The one thing to hold on to before changing this dialog: **it is not a
 * transfer**. Both actions can name the same physical area, and they mean
 * opposite things —
 *
 *     Transfer → QC 1 › Freezer 1     still inventory, at a new node
 *     Issue    → QC 1                 gone from inventory
 *
 * so the destination here is the LOCATION, never a shelf or freezer inside it,
 * and nothing is stored at the far end. That is why the picker lists locations
 * rather than the storage tree the transfer dialog shows, and why the dialog
 * states the consequence twice — once in the body and once in the signature's
 * meaning, which is the last thing read before it becomes irreversible.
 *
 * Source selection reuses the kitting Issue picker, so an issue can draw from
 * several lots / locations and pick exact LN2 vials, signed once.
 */
export function IssueToLocationDialog({ open, onOpenChange, item, onDone }: Props) {
  const [lots, setLots] = React.useState<KitLineSourceLot[] | null>(null);
  const [destinations, setDestinations] = React.useState<IssueDestination[] | null>(null);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [kind, setKind] = React.useState<DestinationKind>('location');
  const [picks, setPicks] = React.useState<LotPick[]>([]);
  const [destSel, setDestSel] = React.useState('');
  const [customerSel, setCustomerSel] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setLots(null);
    setDestinations(null);
    setCustomers([]);
    setKind('location');
    setPicks([]);
    setDestSel('');
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
      issuesApi.sources(item.uuid, { signal: ctrl.signal }),
      issuesApi.destinations({ signal: ctrl.signal }),
      // Customers are a destination kind now, not a separate dialog. Failing
      // this fetch must not take the whole dialog down — issuing to a lab still
      // works with no customers on file.
      customersApi.list({}, { signal: ctrl.signal }).catch(() => [] as Customer[]),
    ])
      .then(([src, dests, custs]) => {
        const mapped = src.map(toSourceLot);
        setLots(mapped);
        setDestinations(dests);
        setCustomers(custs);
        // Seed one blank pick row — there is no target quantity; the operator
        // decides how much leaves.
        setPicks(autoFillFifo(mapped, 0));
        // One destination is the common case (a site with a single QC lab), and
        // making the operator open a select to choose the only option is
        // friction with no decision in it.
        if (dests.length === 1 && dests[0]) setDestSel(dests[0].node_id);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError('Failed to load issuable stock.');
      });
    return () => ctrl.abort();
  }, [open, item]);

  const total = picksTotal(picks);
  const noStock = lots !== null && lots.length === 0;
  // An empty destination list is a setup state, not a failure: nobody has
  // created a debit-and-gone location yet. Saying so — and where to fix it —
  // beats an empty select the operator cannot act on.
  const noDestinations = destinations !== null && destinations.length === 0;
  const picksOk = lots !== null && total >= 1 && picksValid(lots, picks);

  const destOptions: SearchableSelectOption[] = React.useMemo(
    () =>
      (destinations ?? []).map((d) => ({
        value: d.node_id,
        label: d.name,
        searchText: `${d.name} ${d.path}`,
      })),
    [destinations],
  );

  const customerOptions: SearchableSelectOption[] = React.useMemo(
    () =>
      customers.map((c) => ({
        value: c.id,
        label: c.name,
        searchText: `${c.name} ${c.contact_person ?? ''} ${c.email ?? ''}`,
      })),
    [customers],
  );

  const toCustomer = kind === 'customer';
  const noCustomers = toCustomer && customers.length === 0;
  // A consumable is consumed the moment it is issued, so there is no tracked
  // balance to send anyone (Transaction Spec §4.3). The backend refuses it —
  // this stops the operator reaching a password prompt first.
  const customerBlocked = Boolean(item?.isConsumable);
  const destLabel = toCustomer
    ? (customers.find((c) => c.id === customerSel)?.name ?? 'this customer')
    : (destinations?.find((d) => d.node_id === destSel)?.name ?? 'this location');
  /** Whichever destination the chosen kind requires. */
  const destChosen = toCustomer ? Boolean(customerSel) : Boolean(destSel);

  const validate = (): string | null => {
    if (toCustomer && customerBlocked) {
      return 'A consumable is consumed when issued, so it cannot go to a customer.';
    }
    if (!toCustomer && noDestinations) return 'No debit-and-gone location has been set up yet.';
    if (noCustomers) return 'No customers are on file yet.';
    if (!lots || lots.length === 0) return 'No stock is available to issue.';
    if (total < 1) return 'Pick at least one lot and quantity to issue.';
    if (!picksValid(lots, picks)) return 'One or more picks exceed the available quantity.';
    if (!destChosen) return 'Choose where the material is going.';
    return null;
  };

  /** Why the operator cannot sign yet — shown next to the button instead of
   *  leaving it greyed out with no explanation. Ordered by what they would fix
   *  first: the destination, then the stock, then the amount. */
  const blockedReason = (): string | null => {
    if (toCustomer && customerBlocked) return 'A consumable cannot go to a customer.';
    if (toCustomer && noCustomers) return 'No customers on file yet.';
    if (!toCustomer && noDestinations) return 'No debit-and-gone location set up yet.';
    if (noStock) return 'No stock available to issue.';
    if (!destChosen) return toCustomer ? 'Choose a customer.' : 'Choose a location.';
    if (total < 1) return 'Add at least one lot and quantity.';
    if (lots && !picksValid(lots, picks)) return 'A pick exceeds the quantity available.';
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
      // Two endpoints behind one control: the destination decides which ledger
      // row is written, so a shipment stays a shipment (named customer, its own
      // movement type) rather than becoming an issue with a customer attached.
      if (toCustomer) {
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
          } issued to ${shipment.customer_name} — removed from inventory`,
        });
      } else {
        const result = await issuesApi.issue({
          sources: picksToSources(picks),
          destination_node_id: destSel,
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
        toast.success('Material issued', {
          description: `${result.total_qty} unit${
            result.total_qty === 1 ? '' : 's'
          } issued to ${result.destination_name} — removed from inventory`,
        });
      }
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
        setError('Failed to record the issue. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Issue material</DialogTitle>
            <DialogDescription>
              Send <span className="font-medium">{item?.desc}</span> out of inventory. To keep
              tracking it, use Transfer.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {noStock ? (
              <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text-2">
                No stock is available to issue.
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>
                    Issue to <span className="text-danger">*</span>
                  </Label>
                  {/* Two kinds, chosen before the destination, because a single
                      mixed dropdown would sit "Acme Bio" next to "PD" as though
                      they were the same sort of place. They are not: one is a
                      company, the other a room.

                      Named for what they ARE, not for what anyone expects to be
                      in them. The operator names their own locations — calling
                      this "Lab / development area" would repeat the mistake of
                      listing example labs, and be wrong the moment someone
                      creates a location called "Scrap". */}
                  {/* Cards, not tabs. The two options are not two views of the
                      same thing — they write DIFFERENT ledger rows, one of which
                      names a customer and one of which does not, and both are
                      irreversible. A card has room to say what each one means,
                      which is the difference between an operator choosing and an
                      operator guessing.

                      Neither description names an example location. The operator
                      names their own, so listing "PD, QC, scrap" would be wrong
                      the moment they call one something else. */}
                  <div
                    role="radiogroup"
                    aria-label="Destination type"
                    className="grid gap-2 sm:grid-cols-2"
                  >
                    {(
                      [
                        {
                          value: 'location' as const,
                          label: 'Debit-and-gone',
                          hint: 'Material ends there.',
                          Icon: MapPin,
                        },
                        {
                          value: 'customer' as const,
                          label: 'Customer',
                          hint: 'Leaves the site, on the record.',
                          Icon: Truck,
                        },
                      ]
                    ).map((opt) => {
                      const active = kind === opt.value;
                      const disabled = opt.value === 'customer' && customerBlocked;
                      const { Icon } = opt;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          disabled={disabled}
                          onClick={() => setKind(opt.value)}
                          title={
                            disabled
                              ? 'A consumable is consumed when issued, so it cannot go to a customer.'
                              : undefined
                          }
                          className={cn(
                            'group relative flex items-start gap-3 rounded-lg border p-3 text-left transition-all',
                            active
                              ? 'border-accent bg-accent-soft/30 ring-1 ring-accent'
                              : 'border-border hover:border-accent/50 hover:bg-surface/60',
                            disabled && 'cursor-not-allowed opacity-45 hover:border-border hover:bg-transparent',
                          )}
                        >
                          <span
                            className={cn(
                              'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors',
                              active
                                ? 'border-accent/40 bg-accent text-white'
                                : 'border-border bg-surface text-text-3',
                            )}
                          >
                            <Icon size={15} />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-text">{opt.label}</span>
                            <span className="mt-0.5 block text-xs leading-snug text-text-3">
                              {opt.hint}
                            </span>
                          </span>
                          {active && (
                            <span className="absolute right-2 top-2 text-accent">
                              <Check size={14} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {customerBlocked && (
                    <p className="text-xs text-text-3">
                      A consumable is consumed the moment it is issued, so there is no tracked
                      stock left to send to a customer.
                    </p>
                  )}

                  {toCustomer ? (
                    <>
                      <SearchableSelect
                        id="issue-customer"
                        modal
                        options={customerOptions}
                        value={customerSel}
                        onChange={setCustomerSel}
                        placeholder="Select a customer…"
                        searchPlaceholder="Search customers…"
                        emptyText="No customers on file."
                      />
                      {noCustomers && (
                        <p className="text-xs text-text-3">
                          No customers have been added yet — add one from Customers first.
                        </p>
                      )}
                      <div className="space-y-1.5 pt-2">
                        <Label htmlFor="issue-reference">Reference number</Label>
                        <Input
                          id="issue-reference"
                          value={reference}
                          onChange={(e) => setReference(e.target.value)}
                          placeholder="e.g. SO-1042 or a tracking number"
                        />
                        <p className="text-xs text-text-3">
                          Optional. The shipping, tracking or sales-order number, kept on the
                          ledger row beside the customer.
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <SearchableSelect
                        id="issue-destination"
                        modal
                        options={destOptions}
                        value={destSel}
                        onChange={setDestSel}
                        placeholder="Select a debit-and-gone location…"
                        searchPlaceholder="Search locations…"
                        emptyText="No debit-and-gone locations."
                      />
                      {noDestinations ? (
                        <p className="text-xs text-text-3">
                          No debit-and-gone location has been set up yet. A super admin can
                          create one from Storage → Create new location, choosing “Leaves
                          inventory when issued”.
                        </p>
                      ) : (
                        /* Say what the picker is NOT offering. An operator looking
                           for "QC 1 › Freezer 1" needs to know it is missing on
                           purpose and which action has it, or they will read the
                           list as broken. */
                        <p className="text-xs text-text-3">
                          The location itself, not a shelf inside it.
                        </p>
                      )}
                    </>
                  )}
                </div>

                {/* Destination BEFORE stock. Where it goes decides which
                    transaction is written, which fields appear, and — for a
                    consumable — whether the action is possible at all. Asking
                    last would mean picking lots that then turn out to be
                    unusable. */}
                <div className="space-y-1.5">
                  <Label>Issue from</Label>
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

                {/* No warning band here. "Permanent, cannot be returned" was
                    being said three times over — in the header, on the chosen
                    card, and again in this box — and the one statement that
                    actually binds is the meaning text on the signature dialog,
                    which the operator must read to proceed. Repeating a warning
                    is how it stops being read. */}
              </>
            )}

            {error && (
              <p
                role="alert"
                className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
              >
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter className="items-center justify-between gap-3 sm:justify-between">
            {/* What is about to happen, in one line, next to the button that
                does it — and when it cannot happen, why. A greyed-out button
                with no explanation is the most common dead end in this app. */}
            <p className="text-xs text-text-3">
              {blockedReason() ? (
                <span className="text-warning">{blockedReason()}</span>
              ) : (
                <>
                  Issuing <span className="font-mono text-text">{total}</span>{' '}
                  {total === 1 ? 'unit' : 'units'} to{' '}
                  <span className="font-medium text-text">{destLabel}</span>
                </>
              )}
            </p>
            <div className="flex gap-2">
            <Button type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={openSign}
              disabled={
                submitting ||
                noStock ||
                (!toCustomer && noDestinations) ||
                noCustomers ||
                !picksOk ||
                !destChosen
              }
            >
              <MinusCircle size={14} /> Sign &amp; issue
            </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action={toCustomer ? 'movement.customer_shipment' : MATERIAL_ISSUE_ACTION}
        recordTable="app.items"
        recordId={item?.uuid}
        meaning={`I am issuing ${total} unit(s) of ${
          item?.desc ?? 'this item'
        } to ${destLabel}. This removes them from inventory permanently.`}
        commentPlaceholder={
          toCustomer ? 'e.g. Shipped against SO-1042' : 'e.g. Sent to QC for release testing'
        }
        onConfirmed={submit}
        title="Sign this issue"
        submitLabel="Sign & issue"
      />
    </>
  );
}
