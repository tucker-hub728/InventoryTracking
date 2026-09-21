'use client';

import * as React from 'react';
import { ClipboardList, PackagePlus, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '@/components/ui/searchable-select';
import { toast } from '@/components/ui/sonner';
import { ItemLink } from '@/components/inventory/item-link';
import { AcknowledgeConsumptionAction } from '@/components/consumables/acknowledge-consumption-action';
import { ApiError } from '@/lib/api/client';
import {
  consumablesApi,
  kanbanRestockApi,
  RESTOCK_STATE_LABEL,
  type IssuedConsumable,
  type RestockRequest,
} from '@/lib/api/consumables';
import { itemsApi, type ApiItem } from '@/lib/api/items';
import type { LocationNode } from '@/lib/api/location-nodes';

/**
 * The Kanban restock loop (KAN-001).
 *
 *     request restock  →  acknowledge what was used  →  issue the replenishment
 *
 * **Nothing here is a stock figure.** A Kanban holds no balance: the units were
 * debited when they were issued to the floor (07-09 TRX-001). So this deals in
 * *asks* and *statements*, and the only step that moves stock is the third — an
 * ordinary e-signed issue from the item's own page.
 *
 * Split across two surfaces on purpose:
 *
 *   * **raising** a request is one button for the whole room
 *     (`RequestRestockButton`), because "which station" is the first thing the
 *     dialog asks anyway. It used to sit on every station, which put the same
 *     control on screen once per Kanban and made the page read as though the
 *     stations differed in what you could do with them;
 *   * **answering** one stays per-station (`KanbanRestockSection`), because an
 *     open request belongs to a bin and is acted on while standing at it.
 */
export function KanbanRestockSection({
  kanbanNodeId,
  canEdit,
  canSign,
  reloadKey,
  onChanged,
}: {
  kanbanNodeId: string;
  canEdit: boolean;
  canSign: boolean;
  reloadKey: number;
  onChanged: () => void;
}) {
  const [requests, setRequests] = React.useState<RestockRequest[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState<string | null>(null);

  React.useEffect(() => {
    const ctl = new AbortController();
    (async () => {
      try {
        const res = await kanbanRestockApi.listRequests(
          { kanbanNodeId, state: 'open' },
          { signal: ctl.signal },
        );
        setRequests(res.items);
        setLoadError(null);
      } catch (err) {
        if (ctl.signal.aborted) return;
        setLoadError(err instanceof ApiError ? err.message : 'Could not load restock requests.');
      }
    })();
    return () => ctl.abort();
  }, [kanbanNodeId, reloadKey]);

  const cancel = async (id: string) => {
    setCancelling(id);
    try {
      await kanbanRestockApi.cancelRequest(id);
      toast.success('Request withdrawn');
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not withdraw the request.');
    } finally {
      setCancelling(null);
    }
  };

  if (loadError) return <p className="px-3 py-2 text-xs text-danger">{loadError}</p>;
  if (requests === null || requests.length === 0) return null;

  return (
    <>
      <div className="border-b border-border bg-warning/5 px-3 py-1.5">
        <span className="text-xs font-medium text-warning">
          {requests.length} open restock request{requests.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
            <ItemLink itemId={r.item_id} itemNumber={r.item_number} />
            <Badge tone="warning" className="gap-1">
              <ClipboardList size={11} />
              Requested
              {r.requested_qty !== null && <> ×{r.requested_qty}</>}
            </Badge>
            {/* Not a bin balance — how much has arrived against THIS ask. It is
                the question an operator actually has while a request is open,
                and the one a Kanban can honestly answer. */}
            {r.issued_since_qty > 0 && (
              <span className="text-xs text-success">{r.issued_since_qty} issued since</span>
            )}
            {r.note && <span className="text-xs text-text-3">“{r.note}”</span>}
            <span className="ml-auto flex items-center gap-1">
              {canSign && <AcknowledgeConsumptionAction request={r} onDone={onChanged} />}
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cancel(r.id)}
                  disabled={cancelling === r.id}
                  title="Withdraw this request"
                >
                  <X size={14} />
                </Button>
              )}
            </span>
            <span className="w-full text-xs text-text-3">
              Asked {new Date(r.requested_at).toLocaleDateString()}
              {r.requested_by && <> by {r.requested_by}</>}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The room-level control, sitting beside "Add kanban". */
export function RequestRestockButton({
  kanbans,
  onDone,
}: {
  kanbans: LocationNode[];
  onDone: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} disabled={kanbans.length === 0}>
        <PackagePlus size={15} /> Request restock
      </Button>
      <RequestRestockDialog
        open={open}
        kanbans={kanbans}
        onOpenChange={setOpen}
        onDone={() => {
          setOpen(false);
          onDone();
        }}
      />
    </>
  );
}

/**
 * "We are low on this." Not e-signed — no stock moves and nothing is asserted
 * about material, so there is nothing for a password to attest to.
 *
 * Asks in the order the operator thinks: **which station → which item → how
 * many**. The history panel appears once the first two are answered, because
 * that is the moment it can say anything useful — and it is what makes the
 * quantity box answerable. "How many are needed?" is otherwise a question
 * about a bin the system deliberately does not count; what it CAN say is what
 * was issued here before and how much of it was reported used, which is the
 * evidence an operator would otherwise go and look up.
 *
 * The item list is every consumable, not just ones this bin has held: a station
 * stocking something new is the normal case, and exactly when an ask is needed.
 */
function RequestRestockDialog({
  open,
  kanbans,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  kanbans: LocationNode[];
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [items, setItems] = React.useState<ApiItem[] | null>(null);
  const [openRequests, setOpenRequests] = React.useState<RestockRequest[]>([]);
  const [kanbanId, setKanbanId] = React.useState('');
  const [itemId, setItemId] = React.useState('');
  const [qty, setQty] = React.useState('');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    // One station is the common case; making the operator pick the only option
    // is friction with no decision in it.
    setKanbanId(kanbans.length === 1 ? (kanbans[0]?.id ?? '') : '');
    setItemId('');
    setQty('');
    setNote('');
    setError(null);
    setBusy(false);
    const ctl = new AbortController();
    Promise.all([
      itemsApi.listAll({ is_consumable: true }, { signal: ctl.signal }),
      // Every open ask in this room, so the item list can hide the ones that
      // would be refused as duplicates (one open request per bin per item).
      kanbanRestockApi.listAllRequests({ state: 'open' }, { signal: ctl.signal }),
    ])
      .then(([itemRes, reqRes]) => {
        setItems(itemRes);
        setOpenRequests(reqRes);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setItems([]);
      });
    return () => ctl.abort();
  }, [open, kanbans]);

  const kanbanOptions: SearchableSelectOption[] = React.useMemo(
    () => kanbans.map((k) => ({ value: k.id, label: k.name, searchText: `${k.name} ${k.code}` })),
    [kanbans],
  );

  const takenHere = React.useMemo(
    () =>
      new Set(
        openRequests.filter((r) => r.kanban_node_id === kanbanId).map((r) => r.item_id),
      ),
    [openRequests, kanbanId],
  );

  const itemOptions: SearchableSelectOption[] = React.useMemo(
    () =>
      (items ?? [])
        .filter((i) => !takenHere.has(i.id))
        .map((i) => ({
          value: i.id,
          label: i.item_number,
          searchText: `${i.item_number} ${i.description ?? ''}`,
          hint: i.description ?? undefined,
        })),
    [items, takenHere],
  );

  const submit = async () => {
    if (!kanbanId || !itemId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await kanbanRestockApi.createRequest({
        kanban_node_id: kanbanId,
        item_id: itemId,
        // Blank means "we're low, I haven't counted" — a legitimate request, so
        // it is sent as null rather than coerced to 0.
        requested_qty: qty.trim() === '' ? null : Number(qty),
        note: note.trim() || null,
      });
      toast.success('Restock requested', {
        description: kanbans.find((k) => k.id === kanbanId)?.name,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not raise the request.');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Request restock</DialogTitle>
          <DialogDescription>
            Flags a Kanban as low. Nothing moves yet — someone confirms what was used, then
            issues the replenishment.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="restock-kanban">
              Which Kanban? <span className="text-danger">*</span>
            </Label>
            <SearchableSelect
              id="restock-kanban"
              modal
              options={kanbanOptions}
              value={kanbanId}
              onChange={(v) => {
                setKanbanId(v);
                // The item list is filtered per station, so a selection made
                // against the previous one may no longer be offered.
                setItemId('');
              }}
              placeholder="Select a station…"
              searchPlaceholder="Search stations…"
              emptyText="No Kanban stations in this area yet."
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="restock-item">
              Which consumable? <span className="text-danger">*</span>
            </Label>
            <SearchableSelect
              id="restock-item"
              modal
              options={itemOptions}
              value={itemId}
              onChange={setItemId}
              placeholder={items === null ? 'Loading…' : 'Select a consumable…'}
              searchPlaceholder="Search consumables…"
              emptyText={
                items !== null && items.length > 0
                  ? 'Every consumable already has an open request here.'
                  : 'No consumables on file.'
              }
            />
          </div>

          <RestockHistory kanbanNodeId={kanbanId} itemId={itemId} />

          <div className="space-y-1.5">
            <Label htmlFor="restock-qty">How many are needed? (optional)</Label>
            <Input
              id="restock-qty"
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="Leave blank if you haven't counted"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="restock-note">Note (optional)</Label>
            <Input
              id="restock-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. down to the last box"
            />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !kanbanId || !itemId}>
            <PackagePlus size={14} /> {busy ? 'Requesting…' : 'Request restock'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What has happened to this item at this station: what was issued in, and what
 * past requests reported consumed.
 *
 * This is the closest thing to a bin balance the system can honestly show, and
 * the wording is careful not to imply more than it knows. Issues are ledger
 * facts. Consumption figures are what an operator *said* was used — recorded,
 * attributable, and deliberately not reconciled against the issues, because
 * nothing counts what is physically in the bin.
 */
function RestockHistory({ kanbanNodeId, itemId }: { kanbanNodeId: string; itemId: string }) {
  const [issues, setIssues] = React.useState<IssuedConsumable[] | null>(null);
  const [past, setPast] = React.useState<RestockRequest[]>([]);

  React.useEffect(() => {
    if (!kanbanNodeId || !itemId) {
      setIssues(null);
      setPast([]);
      return;
    }
    const ctl = new AbortController();
    Promise.all([
      consumablesApi.issued(
        { kanbanNodeId, itemId, includeCleared: true },
        { signal: ctl.signal },
      ),
      kanbanRestockApi.listRequests({ kanbanNodeId, limit: 50 }, { signal: ctl.signal }),
    ])
      .then(([iss, reqs]) => {
        setIssues(iss);
        setPast(reqs.items.filter((r) => r.item_id === itemId && r.state === 'fulfilled'));
      })
      .catch(() => {
        if (!ctl.signal.aborted) setIssues([]);
      });
    return () => ctl.abort();
  }, [kanbanNodeId, itemId]);

  if (!kanbanNodeId || !itemId) return null;
  if (issues === null) {
    return <p className="text-xs text-text-3">Loading history…</p>;
  }

  const totalIssued = issues.reduce((n, i) => n + i.qty, 0);
  const totalConsumed = past.reduce((n, r) => n + (r.consumed_qty ?? 0), 0);

  if (issues.length === 0 && past.length === 0) {
    return (
      <div className="rounded-md border border-border bg-surface-2 px-3 py-2.5 text-xs text-text-3">
        Nothing has been issued to this station for this item yet.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-surface-2 px-3 py-2.5 text-xs">
      <p className="font-medium text-text">History at this station</p>
      <p className="mt-1 text-text-3">
        <span className="text-text">{totalIssued}</span> issued in total
        {past.length > 0 && (
          <>
            {' · '}
            <span className="text-text">{totalConsumed}</span> reported used across{' '}
            {past.length} closed request{past.length === 1 ? '' : 's'}
          </>
        )}
      </p>
      {/* The last few issues, newest first. Enough to size a request without
          turning the dialog into the register — the full list is a click away
          on the station itself. */}
      <ul className="mt-2 space-y-0.5 text-text-3">
        {issues.slice(0, 4).map((i) => (
          <li key={i.id}>
            {new Date(i.issued_at).toLocaleDateString()} · ×{i.qty}
            {i.lot_number && <> · Lot {i.lot_number}</>}
            {i.cleared_at && <span className="text-success"> · checked</span>}
          </li>
        ))}
        {issues.length > 4 && <li>…and {issues.length - 4} earlier</li>}
      </ul>
      {past.slice(0, 2).map((r) => (
        <p key={r.id} className="mt-1 text-text-3">
          {RESTOCK_STATE_LABEL[r.state]} {r.closed_at && new Date(r.closed_at).toLocaleDateString()}
          {r.consumed_qty !== null && <> · {r.consumed_qty} reported used</>}
        </p>
      ))}
    </div>
  );
}

