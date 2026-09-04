'use client';

import * as React from 'react';
import { Check, MapPin, MinusCircle, PackageOpen, Truck } from 'lucide-react';

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
import {
  CONSUMABLE_ISSUE_ACTION,
  consumablesApi,
  type ConsumableSource,
} from '@/lib/api/consumables';
import {
  LocationTreePicker,
  nodeChain,
  useLocationForest,
} from '@/components/reconciliation/location-tree-picker';
import { refreshNavCounts } from '@/hooks/use-nav-counts';

/** Where material can go when it leaves the shelf (REQ-2026-07-31-TRX-001).
 *
 *  One control, three distinct transactions — deliberately not one transaction
 *  with three flavours. A customer shipment carries a customer and a reference
 *  number and is the terminal event for a product (REQ-2026-07-09-TRX-001); an
 *  issue to a lab carries neither and simply ends the material's life in the
 *  system; a Kanban issue MOVES a consumable to the production floor and is not
 *  terminal at all since KAN-001. Merging their LEDGERS would cost CUST-001 its
 *  requirement that the movement names the customer, and would cost KAN-001 its
 *  Kanban balance, so what is unified here is the operator's entry point, not
 *  the record.
 *
 *  **Kanban joined this control on 2026-08-27** (client), replacing a second
 *  primary "Issue to Kanban" button in the item header. Two buttons a few
 *  pixels apart, both meaning "issue", made the operator classify the
 *  transaction before opening anything — which is exactly the choice this
 *  radiogroup exists to present properly, with each option's consequence
 *  spelled out next to it.
 */
type DestinationKind = 'location' | 'customer' | 'kanban';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The item being issued. Any item may be issued to an internal location;
   *  ``isConsumable`` decides the other two options — it is the ONLY kind that
   *  may go to a Kanban, and the only kind that may NOT go to a customer (it is
   *  bought to be used on the floor, not sold on). Both are settled here rather
   *  than after the operator has signed. */
  item: { uuid: string; id: string; desc: string; isConsumable?: boolean } | null;
  /** Opened in answer to a restock request: aim the dialog at the Kanban that
   *  asked, and pre-fill what it asked for.
   *
   *  Only the DESTINATION and the target quantity are seeded. The lots are
   *  still chosen here, because which lot leaves the shelf is a decision the
   *  requester never made and cannot make — they are standing at a bin on a
   *  production floor, not in front of the stock. */
  prefill?: { kanbanNodeId: string; qty: number | null } | null;
  onDone: () => void;
}

/** One mapper for both source endpoints — the two payloads are structurally
 *  identical, and the shared function is what stops them drifting.
 *
 *  **The grid fields are carried through, never blanked.** The Kanban flow used
 *  to assume a consumable always sits on a shelf — gloves, not cryo vials —
 *  which flattened a box source to a plain number box and hid the grid kitting
 *  shows for the same lot; the backend then drained the lot FIFO and emptied
 *  vial positions nobody had pulled. CR-004 in Tank 1 (client 2026-08-11) is
 *  the case that disproves the assumption. Any flow reusing `LotSourcePicker`
 *  has to pass these through — dropping them is silent and looks like a
 *  UI-only shortcut. */
function toSourceLot(s: IssueSource | ConsumableSource): KitLineSourceLot {
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
export function IssueToLocationDialog({ open, onOpenChange, item, prefill, onDone }: Props) {
  const [lots, setLots] = React.useState<KitLineSourceLot[] | null>(null);
  // Kanban sources come from a DIFFERENT endpoint, not a filter of the list
  // above: `/consumables/sources` enforces `is_consumable`, and since kan01 it
  // also excludes stock already sitting in a Kanban, so the floor's own gloves
  // can't be issued to the floor again. Held separately and swapped in by kind
  // rather than merged, because a pick row addresses a (lot × node) in ONE of
  // the two lists and carrying picks across would silently address the wrong
  // row.
  const [kanbanLots, setKanbanLots] = React.useState<KitLineSourceLot[] | null>(null);
  const [destinations, setDestinations] = React.useState<IssueDestination[] | null>(null);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [kind, setKind] = React.useState<DestinationKind>('location');
  const [picks, setPicks] = React.useState<LotPick[]>([]);
  const [destSel, setDestSel] = React.useState('');
  const [kanbanSel, setKanbanSel] = React.useState('');
  const [customerSel, setCustomerSel] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Cached location forest, shared with the Kanban picker below.
  const forest = useLocationForest();

  React.useEffect(() => {
    if (!open) return;
    setLots(null);
    setKanbanLots(null);
    setDestinations(null);
    setCustomers([]);
    // A consumable opens on Kanban: it is what that item is issued for almost
    // every time, and it is what the old dedicated button did in one click.
    // Merging the buttons should not cost the common case an extra one.
    setKind(prefill ? 'kanban' : item?.isConsumable ? 'kanban' : 'location');
    setPicks([]);
    setDestSel('');
    // Answering a restock request aims at the Kanban that asked. Everything
    // else stays an explicit choice — a pre-selected destination cannot issue
    // anything on its own, and the lots are still picked below.
    setKanbanSel(prefill?.kanbanNodeId ?? '');
    setCustomerSel('');
    setReference('');
    setShowReauth(false);
    setSubmitting(false);
    setError(null);
  }, [open, item, prefill]);

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
      // Only a consumable can go to a Kanban, so only a consumable pays for
      // this request. Failing it must not take the dialog down — issuing to a
      // lab still works — so the Kanban option simply reports no stock.
      item.isConsumable
        ? consumablesApi
            .sources(item.uuid, { signal: ctrl.signal })
            .catch(() => [] as ConsumableSource[])
        : Promise.resolve([] as ConsumableSource[]),
    ])
      .then(([src, dests, custs, kanbanSrc]) => {
        const mapped = src.map(toSourceLot);
        const kanbanMapped = kanbanSrc.map(toSourceLot);
        setLots(mapped);
        setKanbanLots(kanbanMapped);
        setDestinations(dests);
        setCustomers(custs);
        // Seed one blank pick row — there is no target quantity; the operator
        // decides how much leaves. Seeded from the list matching the kind the
        // dialog OPENED on, not always the issue list: a consumable opens on
        // Kanban, and seeding from the other list would put rows on screen that
        // address lots the operator is not looking at.
        // Answering a request auto-fills FIFO to the quantity that was asked
        // for; otherwise a blank row, because there is no target to fill to.
        // Either way the operator can change it — the ask is what somebody
        // estimated they needed, not an instruction to the person with the
        // stock, who can see how much there actually is.
        const seedFrom = item.isConsumable ? kanbanMapped : mapped;
        setPicks(autoFillFifo(seedFrom, prefill?.qty ?? 0));
        // One destination is the common case (a site with a single QC lab), and
        // making the operator open a select to choose the only option is
        // friction with no decision in it.
        if (dests.length === 1 && dests[0]) setDestSel(dests[0].node_id);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError('Failed to load issuable stock.');
      });
    return () => ctrl.abort();
  }, [open, item, prefill]);

  // The list the picker is actually driving. A pick row addresses a
  // (lot × node) in ONE of the two lists, so everything downstream — validation,
  // totals, the submitted sources — has to read the same one the operator saw.
  const activeLots = kind === 'kanban' ? kanbanLots : lots;

  // Switching kind re-seeds the picker against the other list. Without this the
  // old rows survive and validate against lots that are no longer on screen,
  // which is the quiet way to post a source the operator never chose.
  const prevKind = React.useRef(kind);
  React.useEffect(() => {
    if (prevKind.current === kind) return;
    prevKind.current = kind;
    setPicks(activeLots ? autoFillFifo(activeLots, 0) : []);
    setError(null);
  }, [kind, activeLots]);

  const total = picksTotal(picks);
  const noStock = activeLots !== null && activeLots.length === 0;
  // An empty destination list is a setup state, not a failure: nobody has
  // created a debit-and-gone location yet. Saying so — and where to fix it —
  // beats an empty select the operator cannot act on.
  const noDestinations = destinations !== null && destinations.length === 0;
  const picksOk = activeLots !== null && total >= 1 && picksValid(activeLots, picks);

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
  const toKanban = kind === 'kanban';
  const noCustomers = toCustomer && customers.length === 0;
  // The two kinds are mutually exclusive, and each is a property of the ITEM
  // rather than of anything the operator can set up:
  //
  //   consumable      → Kanban yes, Customer no. Bought to be used on the
  //                     production floor, not sold on.
  //   everything else → Customer yes, Kanban no. A non-consumable reaches
  //                     production on a kit, which is a different flow.
  //
  // Both are HIDDEN rather than shown disabled (client 2026-08-27). A greyed
  // card is worth showing when the operator can do something about it — "no
  // debit-and-gone location set up yet" is a setup state with a fix, so that
  // one still explains itself. This is not: no action on this screen or any
  // other will ever make Customer selectable for a consumable, so the card and
  // its footnote were a permanently dead third of the row.
  const kanbanOffered = Boolean(item?.isConsumable);
  const customerOffered = !item?.isConsumable;

  /** The destination cards this item actually offers, in reading order.
   *
   *  Kanban leads where it applies: on a consumable it is overwhelmingly the
   *  common action, and it is the only option here that does NOT end the
   *  material's life — worth reading before the one that does. */
  const destKinds = React.useMemo(
    () => [
      ...(kanbanOffered
        ? [
            {
              value: 'kanban' as const,
              label: 'Kanban',
              hint: 'Stays in stock, on the floor.',
              Icon: PackageOpen,
            },
          ]
        : []),
      {
        value: 'location' as const,
        label: 'Debit-and-gone',
        hint: 'Material ends there.',
        Icon: MapPin,
      },
      ...(customerOffered
        ? [
            {
              value: 'customer' as const,
              label: 'Customer',
              hint: 'Leaves the site, on the record.',
              Icon: Truck,
            },
          ]
        : []),
    ],
    [kanbanOffered, customerOffered],
  );
  // The signed statement names the ROOM as well as the station — "Kanban 1"
  // alone is ambiguous when every clean room has one. Same cached forest the
  // picker reads, so this costs no second fetch.
  const kanbanLabel =
    (forest && kanbanSel ? nodeChain(forest, kanbanSel).at(-1)?.path : null) ?? 'the Kanban';
  const destLabel = toCustomer
    ? (customers.find((c) => c.id === customerSel)?.name ?? 'this customer')
    : toKanban
      ? kanbanLabel
      : (destinations?.find((d) => d.node_id === destSel)?.name ?? 'this location');
  /** Whichever destination the chosen kind requires. */
  const destChosen = toCustomer
    ? Boolean(customerSel)
    : toKanban
      ? Boolean(kanbanSel)
      : Boolean(destSel);

  const validate = (): string | null => {
    // Backstop only — the card is not rendered for a consumable, so this is
    // unreachable from the UI. Kept because the rule is the backend's and a
    // future caller setting `kind` directly should fail here, not at a
    // password prompt.
    if (toCustomer && !customerOffered) {
      return 'A consumable is used on the floor, so it cannot go to a customer.';
    }
    if (kind === 'location' && noDestinations) {
      return 'No debit-and-gone location has been set up yet.';
    }
    if (noCustomers) return 'No customers are on file yet.';
    if (!activeLots || activeLots.length === 0) return 'No stock is available to issue.';
    if (total < 1) return 'Pick at least one lot and quantity to issue.';
    if (!picksValid(activeLots, picks)) return 'One or more picks exceed the available quantity.';
    if (!destChosen) return 'Choose where the material is going.';
    return null;
  };

  /** Why the operator cannot sign yet — shown next to the button instead of
   *  leaving it greyed out with no explanation. Ordered by what they would fix
   *  first: the destination, then the stock, then the amount. */
  const blockedReason = (): string | null => {
    if (toCustomer && noCustomers) return 'No customers on file yet.';
    if (kind === 'location' && noDestinations) return 'No debit-and-gone location set up yet.';
    if (noStock) return 'No stock available to issue.';
    if (!destChosen) {
      if (toCustomer) return 'Choose a customer.';
      return toKanban ? 'Choose a Kanban.' : 'Choose a location.';
    }
    if (total < 1) return 'Add at least one lot and quantity.';
    if (activeLots && !picksValid(activeLots, picks)) {
      return 'A pick exceeds the quantity available.';
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
    setSubmitting(true);
    setError(null);
    try {
      // Three endpoints behind one control: the destination decides which
      // ledger row is written, so a shipment stays a shipment (named customer,
      // its own movement type) and a Kanban issue stays a MOVE (paired legs, a
      // balance at the far end) rather than either becoming an issue with a
      // field attached.
      if (toKanban) {
        const result = await consumablesApi.issue({
          // The picker's own converter: it drops empty rows and, for a box
          // source, sends the tapped vials with the quantity derived from them.
          // Mapping rows by hand here is what silently posted `qty` without the
          // cells and emptied the wrong vials.
          sources: picksToSources(picks),
          kanban_node_id: kanbanSel,
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
        toast.success('Issued to Kanban', {
          description: `${result.total_qty} unit${
            result.total_qty === 1 ? '' : 's'
          } moved to ${result.kanban_path}`,
        });
        // Issuing a lot that is already expired adds to the alert count now.
        refreshNavCounts();
      } else if (toCustomer) {
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
            {/* The description follows the chosen kind, because two of the
                three end the material's life and one does not — a single line
                covering both would have to be vague enough to be useless. */}
            <DialogDescription>
              {toKanban ? (
                <>
                  Move <span className="font-medium">{item?.desc}</span> to a production area. It
                  stays in inventory at the Kanban and is written off when consumption is
                  acknowledged.
                </>
              ) : (
                <>
                  Send <span className="font-medium">{item?.desc}</span> out of inventory. To keep
                  tracking it, use Transfer.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {/* The destination block renders ALWAYS, including when there is no
                stock. It used to sit inside the no-stock branch, which was
                harmless while every kind drew on the same list — but the Kanban
                kind has its own, so an item with nothing issuable to a Kanban
                would hide the very control needed to switch back to the other
                two, stranding the operator on an empty tab. */}
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
                  {/* Two columns because `destKinds` always holds exactly two:
                      an item is either a consumable (Kanban + Debit-and-gone)
                      or it is not (Debit-and-gone + Customer). Add a third kind
                      and this needs revisiting — which is why the invariant is
                      written down rather than left to be re-derived. */}
                  <div
                    role="radiogroup"
                    aria-label="Destination type"
                    className="grid gap-2 sm:grid-cols-2"
                  >
                    {destKinds.map((opt) => {
                      const active = kind === opt.value;
                      const { Icon } = opt;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setKind(opt.value)}
                          className={cn(
                            'group relative flex items-start gap-3 rounded-lg border p-3 text-left transition-all',
                            active
                              ? 'border-accent bg-accent-soft/30 ring-1 ring-accent'
                              : 'border-border hover:border-accent/50 hover:bg-surface/60',
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

                  {toKanban ? (
                    <>
                      {/* The same tree picker the storage flows use, scoped to
                          the Production branch. Areas render as expandable
                          parents and only their Kanbans are pickable — the rule
                          (client 2026-08-10) expressed in the control itself
                          rather than as a second dropdown. */}
                      <LocationTreePicker
                        modal
                        aria-label="Kanban"
                        areas={['production']}
                        value={kanbanSel}
                        onChange={setKanbanSel}
                        selectable={(n) => n.nodeType === 'kanban'}
                        placeholder="Choose a Kanban"
                        emptyText="No Kanban stations yet — a super admin adds one on a production area's Kanban tab."
                      />
                      <p className="text-xs text-text-3">
                        Consumables are issued to a Kanban station, never to the room itself. The
                        stock stays on the books until someone acknowledges what was used.
                      </p>
                    </>
                  ) : toCustomer ? (
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
                  {noStock ? (
                    <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text-2">
                      {toKanban
                        ? 'None of this consumable is on a shelf to issue. Receive some first — stock already in a Kanban cannot be issued again.'
                        : 'No stock is available to issue.'}
                    </p>
                  ) : activeLots === null ? (
                    <p className="text-xs text-text-3">Loading available stock…</p>
                  ) : (
                    <LotSourcePicker
                      modal
                      itemNumber={item?.id ?? ''}
                      lots={activeLots}
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
                // Only the debit-and-gone kind needs a destination list; a
                // Kanban issue must not be blocked by there being no QC lab.
                (kind === 'location' && noDestinations) ||
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
        // Each destination signs under its own verb. A ticket minted to move
        // gloves onto the floor must not be spendable on shipping product to a
        // customer, and the backend matches the verb to the endpoint.
        action={
          toKanban
            ? CONSUMABLE_ISSUE_ACTION
            : toCustomer
              ? 'movement.customer_shipment'
              : MATERIAL_ISSUE_ACTION
        }
        recordTable="app.items"
        recordId={item?.uuid}
        // The Kanban wording is deliberately NOT the other two. Since KAN-001
        // that stock is still on the books — it moves to the floor and leaves
        // only when someone acknowledges what was used — so attesting that it
        // was "removed permanently" would be signing for something untrue.
        meaning={
          toKanban
            ? `I am issuing ${total} unit(s) of ${
                item?.desc ?? 'this consumable'
              } to ${destLabel}. They stay in inventory at that Kanban until consumption is acknowledged.`
            : `I am issuing ${total} unit(s) of ${
                item?.desc ?? 'this item'
              } to ${destLabel}. This removes them from inventory permanently.`
        }
        commentPlaceholder={
          toKanban
            ? 'e.g. Restocking the glove station'
            : toCustomer
              ? 'e.g. Shipped against SO-1042'
              : 'e.g. Sent to QC for release testing'
        }
        onConfirmed={submit}
        title="Sign this issue"
        submitLabel="Sign & issue"
      />
    </>
  );
}
