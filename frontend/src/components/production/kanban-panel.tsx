'use client';

import * as React from 'react';
import { AlertTriangle, Boxes, CheckCircle2, Clock, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { EmptyState } from '@/components/shared/empty-state';
import { ItemLink } from '@/components/inventory/item-link';
import { AcknowledgeDialog } from '@/components/consumables/acknowledge-dialog';
import {
  KanbanRestockSection,
  RequestRestockButton,
} from '@/components/production/kanban-restock-panel';
import { ApiError } from '@/lib/api/client';
import {
  consumablesApi,
  DISPOSITION_LABEL,
  type IssuedConsumable,
} from '@/lib/api/consumables';
import { locationNodesApi, type LocationNode } from '@/lib/api/location-nodes';
import { invalidateLocationForest } from '@/components/reconciliation/location-tree-picker';
import { useAuthStore, selectIsSuperAdmin } from '@/stores/auth.store';
import { usePermission } from '@/hooks/use-permission';

/**
 * The Kanban tab of a production floor (REQ-2026-07-01-LOC-006/008, KAN-001).
 *
 * Each station shows two things, and they are different questions about the
 * same material:
 *
 *   * **what needs restocking** — open requests for that station
 *     (`KanbanRestockSection`), shown only when there are any;
 *   * **what is still somebody's problem** — the expiration register, one row
 *     per issued quantity, which outlives the stock itself (TX Spec §4.3).
 *
 * RAISING a request is a room-level button up in the header, not a per-station
 * one: the dialog's first question is which station, so repeating the control
 * on every bin only asked it twice.
 *
 * **Deliberately NOT a stock list.** A Kanban holds no balance: the quantity
 * leaves inventory at the moment of issue (07-09 TRX-001), so there is nothing
 * to count here. A build on 2026-08-27 briefly drew one — `kan01` gave the bin
 * real allocations — and the client reversed it the same day; see the kan01
 * migration and docs/modules/consumables.md §5.
 *
 * That reversal is why the restock action is a BUTTON rather than a row action
 * on a list of contents. There is no list, and there does not need to be: an
 * operator can raise an ask for any consumable, including one this station has
 * never held.
 */
export function KanbanPanel({ areaId }: { areaId: string }) {
  const canManage = useAuthStore(selectIsSuperAdmin);
  // Raising a restock request changes no stock, so it sits on `edit`; writing
  // off what was consumed does, so it sits on `sign` — the same split every
  // other pair of read-and-commit actions in the app uses.
  const canEdit = usePermission('inventory', 'edit');
  const canSign = usePermission('inventory', 'sign');

  const [kanbans, setKanbans] = React.useState<LocationNode[] | null>(null);
  const [rows, setRows] = React.useState<IssuedConsumable[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  /** ``open`` = still to be checked; ``all`` also shows closed-out rows. */
  const [view, setView] = React.useState<'open' | 'all'>('open');
  const [addOpen, setAddOpen] = React.useState(false);
  const [ack, setAck] = React.useState<IssuedConsumable | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoadError(null);
    Promise.all([
      locationNodesApi.kanbans(areaId, { signal: ctrl.signal }),
      // Always fetch the closed-out rows too, even when the Open view is
      // showing: it is one room's worth of records, and having both in hand
      // makes the filter instant and lets each segment carry its own count.
      consumablesApi.issued(
        { kanbanNodeId: undefined, includeCleared: true },
        { signal: ctrl.signal },
      ),
    ])
      .then(([ks, issued]) => {
        setKanbans(ks);
        // Filter client-side to this area's stations: one request serves every
        // station in the room rather than one per station.
        const ids = new Set(ks.map((k) => k.id));
        setRows(issued.filter((r) => ids.has(r.kanban_node_id)));
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load this room.');
      });
    return () => ctrl.abort();
  }, [areaId, reloadKey]);

  if (loadError) {
    return <EmptyState icon={Boxes} title="Couldn't load the Kanban" hint={loadError} />;
  }
  if (kanbans === null || rows === null) {
    return <p className="p-6 text-center text-xs text-text-3">Loading…</p>;
  }

  const openRows = rows.filter((r) => r.cleared_at === null);
  const checkedCount = rows.length - openRows.length;
  const visible = view === 'open' ? openRows : rows;
  const flagged = openRows.filter((r) => r.flag !== null).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-text-3">
          <Boxes size={13} className="text-accent" />
          {kanbans.length} station{kanbans.length === 1 ? '' : 's'}
          {flagged > 0 && (
            <>
              {' · '}
              <span className="text-warning">
                {flagged} need{flagged === 1 ? 's' : ''} a check
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* A filter that states the VIEW rather than the action. "Hide
              checked" made you read the label, work out the current state from
              it, and invert — and it was a bare text link next to a primary
              button, so it read as fine print. Each segment carries its own
              count, which is the thing an operator actually wants to know. */}
          {checkedCount > 0 && (
            <SegmentedControl
              aria-label="Filter issued consumables"
              value={view}
              onChange={(v) => setView(v as 'open' | 'all')}
              options={[
                { value: 'open', label: <SegmentLabel text="Open" count={openRows.length} /> },
                { value: 'all', label: <SegmentLabel text="All" count={rows.length} /> },
              ]}
            />
          )}
          {/* Room-level, beside Add kanban: "which station" is the dialog's
              first question, so one button covers every Kanban here. It used to
              repeat on each station, which showed the same control once per bin
              and dead-ended when a bin had nothing to hang it on. */}
          {canEdit && kanbans.length > 0 && (
            <RequestRestockButton kanbans={kanbans} onDone={reload} />
          )}
          {canManage && (
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus size={15} /> Add kanban
            </Button>
          )}
        </div>
      </div>

      {kanbans.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No Kanban in this area yet"
          hint={
            canManage
              ? 'Add one to start issuing consumables here — a consumable is always issued to a Kanban, never to the room itself.'
              : 'A super admin needs to add a Kanban station before consumables can be issued to this area.'
          }
        />
      ) : (
        kanbans.map((k) => (
          <KanbanStation
            key={k.id}
            station={k}
            rows={visible.filter((r) => r.kanban_node_id === k.id)}
            emptyText={
              view === 'open' && rows.some((r) => r.kanban_node_id === k.id)
                ? 'Everything here has been checked.'
                : 'Nothing issued here yet.'
            }
            onAcknowledge={setAck}
            canEdit={canEdit}
            canSign={canSign}
            reloadKey={reloadKey}
            onChanged={reload}
          />
        ))
      )}

      <AddKanbanDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        areaId={areaId}
        existingNames={kanbans.map((k) => k.name)}
        onCreated={reload}
      />
      <AcknowledgeDialog row={ack} onOpenChange={(o) => !o && setAck(null)} onDone={reload} />
    </div>
  );
}

/** Segment caption — label plus its count, the count muted so the word stays
 *  the thing you read first. */
function SegmentLabel({ text, count }: { text: string; count: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {text}
      <span className="tabular-nums opacity-60">{count}</span>
    </span>
  );
}

function KanbanStation({
  station,
  rows,
  emptyText,
  onAcknowledge,
  canEdit,
  canSign,
  reloadKey,
  onChanged,
}: {
  station: LocationNode;
  rows: IssuedConsumable[];
  /** Why this station is empty — "nothing issued" and "all checked" are
   *  different facts, and the Open filter makes the second one common. */
  emptyText: string;
  onAcknowledge: (row: IssuedConsumable) => void;
  canEdit: boolean;
  canSign: boolean;
  reloadKey: number;
  onChanged: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {/* Name only. The generated code ("KAN-KANBAN-2") is an internal
          uniqueness key derived from the name, so on screen it just repeated
          the heading in shoutier form. It still exists on the record and is
          still searchable in the issue picker. */}
      <div className="border-b border-border bg-surface-2 px-3 py-2">
        <span className="text-sm font-medium text-text">{station.name}</span>
      </div>

      {/* Open restock requests (KAN-001) — first, because they are the thing
          waiting on someone. Renders NOTHING when there are none, so a quiet
          station stays quiet instead of carrying a row saying so. */}
      <KanbanRestockSection
        kanbanNodeId={station.id}
        canEdit={canEdit}
        canSign={canSign}
        reloadKey={reloadKey}
        onChanged={onChanged}
      />

      <div className="border-b border-border bg-surface-2 px-3 py-1.5">
        <span className="text-xs font-medium text-text-3">Expiration checks</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-text-3">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <RegisterRow key={r.id} row={r} onAcknowledge={onAcknowledge} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One issued quantity and the state of its expiration check. */
function RegisterRow({
  row,
  onAcknowledge,
}: {
  row: IssuedConsumable;
  onAcknowledge: (row: IssuedConsumable) => void;
}) {
  const cleared = row.cleared_at !== null;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
      <ItemLink itemId={row.item_id} itemNumber={row.item_number} />
      <span className="text-text-3">×{row.qty}</span>
      {row.lot_number && (
        <span className="font-mono text-[11px] text-text-3">Lot {row.lot_number}</span>
      )}
      <ExpiryBadge row={row} />
      <span className="ml-auto flex items-center gap-2 text-[11px] text-text-3">
        <Clock size={12} />
        {new Date(row.issued_at).toLocaleDateString()}
        {row.issued_by && <> · {row.issued_by}</>}
      </span>
      {cleared ? (
        <span className="flex items-center gap-1 text-[11px] text-success">
          <CheckCircle2 size={12} />
          {row.disposition ? DISPOSITION_LABEL[row.disposition] : 'Checked'}
          {row.cleared_by && <> · {row.cleared_by}</>}
        </span>
      ) : (
        // Offered on EVERY open row, not only flagged ones (client
        // 2026-08-10). Nothing in LOC-008 / §4.2 / TRX-006 restricts it to a
        // raised flag — and §4.2's first clearing condition is "the product was
        // consumed before its expiration date", which by definition happens
        // before anything warns. A box used up early otherwise has nowhere to
        // be recorded and sits in the register looking like it is still there.
        <button
          type="button"
          className="text-[11px] text-accent hover:underline"
          onClick={() => onAcknowledge(row)}
        >
          Acknowledge
        </button>
      )}
    </li>
  );
}

function ExpiryBadge({ row }: { row: IssuedConsumable }) {
  // No date, no flag — REQ-2026-07-08-INV-004 as amended 07-09 makes expiration
  // optional at receiving, and "expiration flags apply only where a date exists".
  if (row.expiration_date === null) {
    return <span className="text-[11px] text-text-3">No expiry</span>;
  }
  const d = new Date(row.expiration_date).toLocaleDateString();
  if (row.flag === 'expired') {
    return (
      <Badge tone="danger" className="gap-1">
        <AlertTriangle size={11} /> Expired {d}
      </Badge>
    );
  }
  if (row.flag === 'warn') {
    return (
      <Badge tone="warning" className="gap-1">
        <AlertTriangle size={11} /> Expires {d}
      </Badge>
    );
  }
  return <span className="text-[11px] text-text-3">Expires {d}</span>;
}

function AddKanbanDialog({
  open,
  onOpenChange,
  areaId,
  existingNames,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  areaId: string;
  existingNames: string[];
  onCreated: () => void;
}) {
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const trimmed = name.trim();
  const dupe = existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase());
  const canSubmit = trimmed.length > 0 && !dupe && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.createKanban(areaId, trimmed);
      // The issue dialog's destination picker reads the cached location tree.
      invalidateLocationForest();
      onCreated();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add the Kanban.');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Kanban</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-xs text-text-3">
            A named consumable station inside this area. Consumables are always issued to a
            Kanban, never to the room itself, so a room with two stations keeps them
            separately countable.
          </p>
          <div className="space-y-1.5">
            <label htmlFor="new-kanban-name" className="text-xs font-medium text-text-2">
              Kanban name
            </label>
            <Input
              id="new-kanban-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              placeholder="e.g. Kanban 2"
              maxLength={128}
              aria-label="Kanban name"
            />
            {dupe && (
              <p className="text-xs text-danger">
                A Kanban with that name already exists in this area.
              </p>
            )}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? 'Adding…' : 'Add kanban'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

