'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowRightLeft,
  ArrowUpFromLine,
  Check,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { toast } from '@/components/ui/sonner';
import { usePermission } from '@/hooks/use-permission';
import { lotsApi, type Lot } from '@/lib/api/lots';
import type { ReauthResponse } from '@/lib/api/auth';
import {
  storageApi,
  type PositionEventKind,
  type PositionEventRead,
} from '@/lib/api/storage';
import { useLN2Store } from '@/stores/ln2.store';
import type { Position, PositionStatus } from './ln2-data';
import { POSITION_TONE } from './ln2-data';
import type { BadgeTone } from '@/types/ui';

export interface PositionSelection {
  locationId: string;
  locationName: string;
  rackKey: string;
  rackName: string;
  position: Position;
}

interface Props {
  selection: PositionSelection | null;
  onClose: () => void;
}

const STATUS_TONE: Record<PositionStatus, BadgeTone> = {
  Occupied: 'accent',
  Empty: 'neutral',
};

const STATUS_DESCRIPTION: Record<PositionStatus, string> = {
  Occupied: 'Position is in active use.',
  Empty: 'Available for assignment.',
};

// Position-status section hidden for now (not needed). Flip to true to restore.
const SHOW_POSITION_STATUS = false;

const EVENT_META: Record<
  PositionEventKind,
  { label: string; Icon: LucideIcon; tone: string }
> = {
  assign: { label: 'Unit in', Icon: ArrowDownToLine, tone: 'text-success' },
  empty: { label: 'Unit out', Icon: ArrowUpFromLine, tone: 'text-warning' },
  move_in: { label: 'Moved in', Icon: ArrowRightLeft, tone: 'text-accent' },
  move_out: { label: 'Moved out', Icon: ArrowRightLeft, tone: 'text-accent' },
};

function fmtEventTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function PositionSheet({ selection, onClose }: Props) {
  const canEdit = usePermission('inventory', 'edit');
  const assignPosition = useLN2Store((s) => s.assignPosition);
  const emptyPosition = useLN2Store((s) => s.emptyPosition);

  const [showAssignReauth, setShowAssignReauth] = React.useState(false);
  const [showEmptyReauth, setShowEmptyReauth] = React.useState(false);
  const [lots, setLots] = React.useState<Lot[]>([]);
  const [lotsLoading, setLotsLoading] = React.useState(false);
  const [selectedLot, setSelectedLot] = React.useState<string>('');
  const [assigning, setAssigning] = React.useState(false);
  const [removeDestination, setRemoveDestination] = React.useState('');
  const [history, setHistory] = React.useState<PositionEventRead[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);

  const open = Boolean(selection);
  const info = selection?.position;
  const isEmpty = info?.status === 'Empty';
  const positionId = selection?.position.id ?? null;
  const positionStatus = selection?.position.status;
  const positionLot = selection?.position.lot;

  // E-signature attestations. A grid assign posts a +1 receipt and an empty a
  // −1 dispense, so both are signed like a unit-in / unit-out.
  const slotCtx = selection
    ? `${selection.locationName} · ${selection.rackName} · position ${String(
        info?.index ?? '',
      ).padStart(2, '0')}`
    : '';
  const assignLotNumber =
    lots.find((l) => l.id === selectedLot)?.lot_number ?? selectedLot;
  const assignMeaning = `I attest placing one vial of lot ${assignLotNumber} into ${slotCtx}.`;
  const emptyMeaning = `I attest removing one vial${
    info?.lot ? ` of lot ${info.lot}` : ''
  } from ${slotCtx}${
    removeDestination.trim() ? `, sent to ${removeDestination.trim()}` : ''
  }.`;

  // Reset the inputs whenever the sheet targets a new position.
  React.useEffect(() => {
    setSelectedLot('');
    setRemoveDestination('');
  }, [selection?.position.id]);

  // Load assignable (available) lots when an empty slot is opened.
  React.useEffect(() => {
    if (!open || !isEmpty || !canEdit) return;
    const ctrl = new AbortController();
    setLotsLoading(true);
    lotsApi
      .list({ status: 'available', signal: ctrl.signal })
      .then((rows) => setLots(rows))
      .catch(() => {
        /* aborted or failed — leave the picker empty */
      })
      .finally(() => setLotsLoading(false));
    return () => ctrl.abort();
  }, [open, isEmpty, canEdit]);

  // Position event history — refetched when the slot's occupancy changes
  // (e.g. after assign / empty) so the timeline stays current.
  React.useEffect(() => {
    if (!open || !positionId) return;
    const ctrl = new AbortController();
    setHistoryLoading(true);
    storageApi
      .positionHistory(positionId, { signal: ctrl.signal })
      .then((rows) => setHistory(rows))
      .catch(() => {
        /* aborted or failed — keep prior history */
      })
      .finally(() => setHistoryLoading(false));
    return () => ctrl.abort();
  }, [open, positionId, positionStatus, positionLot]);

  const doAssign = async (evidence: ReauthResponse): Promise<void> => {
    if (!selection || !selectedLot || !canEdit) return;
    setAssigning(true);
    try {
      await assignPosition(selection.position.id, selectedLot, evidence.evidence_id);
      toast.success('Unit in recorded', { description: slotCtx });
      onClose();
    } catch (err) {
      toast.error('Could not assign position', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setAssigning(false);
    }
  };

  const doEmpty = async (evidence: ReauthResponse): Promise<void> => {
    if (!selection || !canEdit || !removeDestination.trim()) return;
    try {
      await emptyPosition(
        selection.position.id,
        evidence.evidence_id,
        removeDestination.trim(),
      );
      toast.success('Unit out recorded', {
        description: `${slotCtx} → ${removeDestination.trim()}`,
      });
      onClose();
    } catch (err) {
      toast.error('Could not empty position', {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        {selection && info && (
          <>
            <SheetHeader>
              <div className="min-w-0">
                <SheetDescription className="text-text-3">
                  {selection.locationName} · {selection.rackName}
                </SheetDescription>
                <SheetTitle>Position {String(info.index).padStart(2, '0')}</SheetTitle>
              </div>
            </SheetHeader>

            <SheetBody className="space-y-6">
              {/* POSITION STATUS — hidden for now (SHOW_POSITION_STATUS) */}
              {SHOW_POSITION_STATUS && (
                <section>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-3">
                    Position status
                  </h3>
                  <div className="overflow-hidden rounded-md border border-border bg-bg-elev">
                    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                      <span className="text-sm text-text-2">Status</span>
                      <Badge tone={STATUS_TONE[info.status]} dot>
                        {POSITION_TONE[info.status].label}
                      </Badge>
                    </div>
                    <p className="px-4 py-3 text-center text-sm text-text-3">
                      {STATUS_DESCRIPTION[info.status]}
                    </p>
                  </div>
                </section>
              )}

              {/* ITEM CARD (occupied only) */}
              {info.item && (
                <section>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-3">
                    Item
                  </h3>
                  <div className="space-y-3 rounded-md border border-border bg-surface p-4 text-sm">
                    <div>
                      <div className="font-medium">{info.item.desc || '—'}</div>
                      <div className="mt-0.5 font-mono text-xs text-accent">{info.item.id}</div>
                    </div>
                    <dl className="grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs">
                      <KV k="Vendor" v={info.item.vendor} />
                      <KV k="Lot" v={info.lot ?? '—'} mono />
                    </dl>
                    <Button asChild variant="ghost" size="sm" className="w-full justify-between">
                      <Link href={`/inventory/${info.item.id}`}>
                        Open item page <ArrowRight size={13} />
                      </Link>
                    </Button>
                  </div>
                </section>
              )}

              {/* REMOVE (occupied slot + editor only) — a unit-out */}
              {canEdit && info.status === 'Occupied' && (
                <section>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-3">
                    Remove unit
                  </h3>
                  <p className="mb-3 text-xs text-text-3">
                    Take this vial out of storage. Records a signed unit-out —
                    capture where it goes.
                  </p>
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="remove-dest">
                        Destination <span className="text-danger">*</span>
                      </Label>
                      <Input
                        id="remove-dest"
                        placeholder="e.g. PD Lab, Patient 123, Shipment SH-001"
                        value={removeDestination}
                        onChange={(e) => setRemoveDestination(e.target.value)}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="danger"
                      size="md"
                      onClick={() => setShowEmptyReauth(true)}
                      disabled={!removeDestination.trim()}
                    >
                      <Trash2 size={13} /> Empty position
                    </Button>
                  </div>
                </section>
              )}

              {/* ASSIGN (empty slot + editor only) */}
              {canEdit && isEmpty && (
                <section>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-3">
                    Assign a lot
                  </h3>
                  <p className="mb-3 text-xs text-text-3">
                    Place one vial from a released lot into this position. Logged to the audit
                    trail.
                  </p>
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="assign-lot">Lot</Label>
                      <Select value={selectedLot} onValueChange={setSelectedLot}>
                        <SelectTrigger id="assign-lot">
                          <SelectValue
                            placeholder={lotsLoading ? 'Loading lots…' : 'Select a lot'}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {lots.map((lot) => (
                            <SelectItem key={lot.id} value={lot.id}>
                              {(lot.item_number ? `${lot.item_number} · ` : '') + lot.lot_number}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      type="button"
                      variant="primary"
                      size="md"
                      onClick={() => setShowAssignReauth(true)}
                      disabled={!selectedLot || assigning}
                    >
                      <Check size={13} /> Assign lot
                    </Button>
                  </div>
                </section>
              )}

              {/* HISTORY — unit in / out / move events for this slot */}
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-3">
                  History
                </h3>
                {historyLoading && history.length === 0 ? (
                  <p className="text-xs text-text-3">Loading history…</p>
                ) : history.length === 0 ? (
                  <p className="text-xs text-text-3">No events yet for this position.</p>
                ) : (
                  <ul className="space-y-3">
                    {history.map((e) => {
                      const meta = EVENT_META[e.event_kind];
                      const Icon = meta.Icon;
                      const counterpart = e.counterpart_label
                        ? `${e.event_kind === 'move_out' ? 'to' : 'from'} ${
                            e.counterpart_location ?? ''
                          } · ${e.counterpart_label}`
                        : null;
                      const meta2 = [e.lot_number, counterpart, e.actor_name]
                        .filter(Boolean)
                        .join('  ·  ');
                      return (
                        <li key={e.id} className="flex gap-2.5">
                          <span className={`mt-0.5 ${meta.tone}`}>
                            <Icon size={14} aria-hidden />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-sm font-medium">{meta.label}</span>
                              <span className="whitespace-nowrap text-[11px] text-text-3">
                                {fmtEventTime(e.occurred_at)}
                              </span>
                            </div>
                            {meta2 && <div className="text-xs text-text-3">{meta2}</div>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

            </SheetBody>
          </>
        )}
      </SheetContent>

      <PasswordReauthDialog
        open={showAssignReauth}
        onOpenChange={setShowAssignReauth}
        action="movement.receipt"
        meaning={assignMeaning}
        onConfirmed={doAssign}
        title="Sign this assignment"
        submitLabel="Sign & assign"
      />

      <PasswordReauthDialog
        open={showEmptyReauth}
        onOpenChange={setShowEmptyReauth}
        action="movement.dispense"
        meaning={emptyMeaning}
        onConfirmed={doEmpty}
        title="Sign this removal"
        submitLabel="Sign & empty"
      />
    </Sheet>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-text-3">{k}</dt>
      <dd className={mono ? 'mt-0.5 font-mono text-text' : 'mt-0.5 text-text'}>{v}</dd>
    </div>
  );
}
