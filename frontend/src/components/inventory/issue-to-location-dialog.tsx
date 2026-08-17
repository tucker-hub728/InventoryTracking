'use client';

import * as React from 'react';
import { MinusCircle } from 'lucide-react';

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
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import type { KitLineSourceLot } from '@/lib/api/kits';
import {
  MATERIAL_ISSUE_ACTION,
  issuesApi,
  type IssueDestination,
  type IssueSource,
} from '@/lib/api/issues';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The item being issued. Any item may be issued — PD/R&D and the QC labs
   *  receive raw material and finished goods alike. */
  item: { uuid: string; id: string; desc: string } | null;
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
  const [picks, setPicks] = React.useState<LotPick[]>([]);
  const [destSel, setDestSel] = React.useState('');
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setLots(null);
    setDestinations(null);
    setPicks([]);
    setDestSel('');
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
    ])
      .then(([src, dests]) => {
        const mapped = src.map(toSourceLot);
        setLots(mapped);
        setDestinations(dests);
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

  const destLabel = destinations?.find((d) => d.node_id === destSel)?.name ?? 'this location';

  const validate = (): string | null => {
    if (noDestinations) return 'No debit-and-gone location has been set up yet.';
    if (!lots || lots.length === 0) return 'No stock is available to issue.';
    if (total < 1) return 'Pick at least one lot and quantity to issue.';
    if (!picksValid(lots, picks)) return 'One or more picks exceed the available quantity.';
    if (!destSel) return 'Choose where the material is going.';
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
              Issue <span className="font-medium">{item?.desc}</span> to a lab or development
              area. This removes it from inventory — it is not a transfer.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {noDestinations ? (
              <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text-2">
                No debit-and-gone location has been set up yet. A super admin can create one
                from Storage → Create new location, choosing “Leaves inventory when issued”.
              </p>
            ) : noStock ? (
              <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text-2">
                No stock is available to issue.
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>Issue from (add a lot per location)</Label>
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
                  <Label htmlFor="issue-destination">
                    Issue to <span className="text-danger">*</span>
                  </Label>
                  <SearchableSelect
                    id="issue-destination"
                    modal
                    options={destOptions}
                    value={destSel}
                    onChange={setDestSel}
                    placeholder="Select a location…"
                    searchPlaceholder="Search locations…"
                    emptyText="No debit-and-gone locations."
                  />
                  {/* Say what the picker is NOT offering. An operator looking for
                      "QC 1 › Freezer 1" needs to know it is missing on purpose
                      and which action has it, or they will read the list as
                      broken. */}
                  <p className="text-xs text-text-3">
                    The location itself, not a shelf or freezer inside it. To move stock into
                    one of those and keep tracking it, use Transfer.
                  </p>
                </div>

                <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
                  {total > 0 ? `These ${total} unit${total === 1 ? '' : 's'} will be` : 'Issued material is'}{' '}
                  removed from inventory permanently and cannot be returned or transferred
                  back. Nothing is stored at {destLabel}.
                </p>
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
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={openSign}
              disabled={submitting || noStock || noDestinations || !picksOk || !destSel}
            >
              <MinusCircle size={14} /> Sign &amp; issue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action={MATERIAL_ISSUE_ACTION}
        recordTable="app.items"
        recordId={item?.uuid}
        meaning={`I am issuing ${total} unit(s) of ${
          item?.desc ?? 'this item'
        } to ${destLabel}. This removes them from inventory permanently.`}
        commentPlaceholder="e.g. Sent to QC for release testing"
        onConfirmed={submit}
        title="Sign this issue"
        submitLabel="Sign & issue"
      />
    </>
  );
}
