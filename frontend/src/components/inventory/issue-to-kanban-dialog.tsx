'use client';

import * as React from 'react';
import { PackageOpen } from 'lucide-react';

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
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import {
  LotSourcePicker,
  picksTotal,
  picksValid,
  type LotPick,
} from '@/components/reconciliation/lot-source-picker';
import { ApiError } from '@/lib/api/client';
import { refreshNavCounts } from '@/hooks/use-nav-counts';
import type { ReauthResponse } from '@/lib/api/auth';
import type { KitLineSourceLot } from '@/lib/api/kits';
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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The consumable being issued. Only rendered for `is_consumable` items. */
  item: { uuid: string; id: string; desc: string } | null;
  onDone: () => void;
}

/** Map an issuable source onto the shape the (reused) kitting lot picker wants.
 *  A consumable never sits in an LN2 box, so the grid fields are always empty —
 *  gloves live on a shelf, not in a cryo vial position. */
function toSourceLot(s: ConsumableSource): KitLineSourceLot {
  return {
    lot_id: s.lot_id,
    lot_number: s.lot_number,
    expiration_date: s.expiration_date,
    node_id: s.node_id,
    node_name: s.location,
    path: s.location,
    qty: s.qty,
    is_grid: false,
    grid_rows: null,
    grid_cols: null,
    cells: [],
  };
}

/**
 * Issue a consumable to a Kanban (REQ-2026-07-01-TRX-003, TX Spec §4).
 *
 * Two things about this transaction are worth knowing before changing it:
 *
 *  * it is **terminal for quantity** (07-09 TRX-001) — the units leave
 *    inventory here and are never back-flushed (TRX-004), so the dialog says so
 *    plainly rather than letting an operator assume a transfer;
 *  * the destination is **always a Kanban**, never the production area itself
 *    (client 2026-08-10), so a room with two stations stays countable.
 *
 * Source selection reuses the kitting Issue picker, so one issue can draw from
 * several lots — and each becomes its own register row, keeping the two
 * expiration dates independent (§4.2).
 */
export function IssueToKanbanDialog({ open, onOpenChange, item, onDone }: Props) {
  const [lots, setLots] = React.useState<KitLineSourceLot[] | null>(null);
  const [kanbanSel, setKanbanSel] = React.useState('');
  const [picks, setPicks] = React.useState<LotPick[]>([]);
  // Same cached forest the picker reads, so the signed statement can name the
  // room without a second fetch.
  const forest = useLocationForest();
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !item) return;
    const ctrl = new AbortController();
    setLots(null);
    setPicks([]);
    setError(null);
    setKanbanSel('');
    consumablesApi
      .sources(item.uuid, { signal: ctrl.signal })
      .then((rows) => setLots(rows.map(toSourceLot)))
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setLots([]);
        setError(err instanceof ApiError ? err.message : 'Failed to load available stock.');
      });
    return () => ctrl.abort();
  }, [open, item]);

  const total = picksTotal(picks);
  const picksOk = lots !== null && picksValid(lots, picks) && total > 0;
  const noStock = lots !== null && lots.length === 0;

  const openSign = () => {
    if (!picksOk || !kanbanSel) return;
    setError(null);
    setShowReauth(true);
  };

  const submit = async (evidence: ReauthResponse) => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await consumablesApi.issue({
        sources: picks.map((p) => ({
          node_id: p.node_id,
          lot_id: p.lot_id,
          qty: p.qty,
        })),
        kanban_node_id: kanbanSel,
        evidence_id: evidence.evidence_id,
        notes: evidence.comment ?? '',
      });
      toast.success('Issued to Kanban', {
        description: `${result.total_qty} unit${
          result.total_qty === 1 ? '' : 's'
        } issued to ${result.kanban_path}`,
      });
      // Issuing a lot that is already expired adds to the alert count now.
      refreshNavCounts();
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

  // The signed statement names the ROOM as well as the station — "Kanban 1"
  // alone is ambiguous when every clean room has one.
  const picked = forest && kanbanSel ? nodeChain(forest, kanbanSel).at(-1) : null;
  const kanbanLabel = picked?.path ?? 'the Kanban';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Issue to Kanban</DialogTitle>
            <DialogDescription>
              Move <span className="font-medium">{item?.desc}</span> to a production area.
              The quantity leaves inventory now and is not returned — only its expiration
              keeps being tracked.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {noStock ? (
              <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text-2">
                There is no stock of this consumable to issue. Receive some first.
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
                  <p className="text-xs text-text-3">
                    Drawing from more than one lot keeps each lot&apos;s expiry tracked
                    separately.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="issue-kanban">
                    Issue to <span className="text-danger">*</span>
                  </Label>
                  {/* The same tree picker the storage flows use, scoped to the
                      Production branch. Areas render as expandable parents and
                      only their Kanbans are pickable — which is the rule
                      (client 2026-08-10) expressed in the control itself rather
                      than as a second dropdown. */}
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
                    Consumables are issued to a Kanban station, never to the room itself.
                  </p>
                </div>
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
              disabled={submitting || noStock || !picksOk || !kanbanSel}
            >
              <PackageOpen size={14} /> Sign &amp; issue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action={CONSUMABLE_ISSUE_ACTION}
        recordTable="app.items"
        recordId={item?.uuid}
        meaning={`I am issuing ${total} unit(s) of ${
          item?.desc ?? 'this consumable'
        } to ${kanbanLabel}. This removes them from inventory permanently.`}
        commentPlaceholder="e.g. Restocking the glove station"
        onConfirmed={submit}
        title="Sign this issue"
        submitLabel="Sign & issue"
      />
    </>
  );
}
