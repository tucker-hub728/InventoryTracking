'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, ArrowRightLeft, Check, ShieldCheck, Trash2 } from 'lucide-react';

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { toast } from '@/components/ui/sonner';
import { usePermission } from '@/hooks/use-permission';
import type { Position, PositionStatus } from './ln2-data';
import { POSITION_TONE } from './ln2-data';
import { cn } from '@/lib/utils';
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
  onUpdate: (patch: Partial<Position>) => void;
}

const STATUS_TONE: Record<PositionStatus, BadgeTone> = {
  Occupied: 'accent',
  Reserved: 'warning',
  Quarantine: 'danger',
  Empty: 'neutral',
};

const STATUS_DESCRIPTION: Record<PositionStatus, string> = {
  Occupied: 'Position is in active use.',
  Reserved: 'Reserved for upcoming receipt.',
  Quarantine: 'Held for quality review.',
  Empty: 'Available for assignment.',
};

const STATUS_OPTIONS: PositionStatus[] = ['Empty', 'Reserved', 'Occupied', 'Quarantine'];

export function PositionSheet({ selection, onClose, onUpdate }: Props) {
  const canEdit = usePermission('inventory', 'edit');
  const [pendingStatus, setPendingStatus] = React.useState<PositionStatus | null>(null);
  const [confirmEmpty, setConfirmEmpty] = React.useState(false);
  const [confirmMove, setConfirmMove] = React.useState(false);

  const open = Boolean(selection);
  const info = selection?.position;

  // Reset working status when the sheet opens / changes target.
  React.useEffect(() => {
    setPendingStatus(info?.status ?? null);
  }, [selection?.position.id, info?.status]);

  const status = pendingStatus ?? info?.status ?? 'Empty';
  const dirty = info ? status !== info.status : false;

  const save = (): void => {
    if (!info || !dirty || !canEdit) return;
    const next: Partial<Position> = { status };
    if (status === 'Empty') {
      next.item = null;
      next.lot = null;
    }
    onUpdate(next);
    toast.success('Position updated', {
      description: `${selection?.position.id} → ${status}`,
    });
  };

  const emptyPosition = async (): Promise<void> => {
    if (!canEdit) return;
    await new Promise((r) => setTimeout(r, 200));
    onUpdate({ status: 'Empty', item: null, lot: null });
    toast.success('Position emptied', { description: selection?.position.id });
    onClose();
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        {selection && info && (
          <>
            <SheetHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <SheetDescription className="text-text-3">
                    {selection.locationName} · {selection.rackName}
                  </SheetDescription>
                  <SheetTitle>Position {String(info.index).padStart(2, '0')}</SheetTitle>
                </div>
                {canEdit && info.status !== 'Empty' && (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmEmpty(true)}
                  >
                    <Trash2 size={13} /> Empty position
                  </Button>
                )}
              </div>
            </SheetHeader>

            <SheetBody className="space-y-6">
              {/* POSITION STATUS */}
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

              {/* ITEM CARD (occupied/quarantine only) */}
              {info.item && (
                <section>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-3">
                    Item
                  </h3>
                  <div className="space-y-3 rounded-md border border-border bg-surface p-4 text-sm">
                    <div>
                      <div className="font-medium">{info.item.desc}</div>
                      <div className="mt-0.5 font-mono text-xs text-accent">{info.item.id}</div>
                    </div>
                    <dl className="grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs">
                      <KV k="Vendor" v={info.item.vendor} />
                      <KV k="Lot" v={info.lot ?? '—'} mono />
                      <KV k="In position" v={`${info.sinceMonths} months`} />
                      <KV k="Category" v={info.item.category} />
                    </dl>
                    <Button asChild variant="ghost" size="sm" className="w-full justify-between">
                      <Link href={`/inventory/${info.item.id}`}>
                        Open item page <ArrowRight size={13} />
                      </Link>
                    </Button>
                  </div>
                </section>
              )}

              {/* UPDATE POSITION */}
              {canEdit && (
                <section>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-3">
                    Update position
                  </h3>
                  <p className="mb-3 text-xs text-text-3">
                    All changes are logged to the audit trail.
                  </p>
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="pos-status">Status</Label>
                      <Select
                        value={status}
                        onValueChange={(v) => setPendingStatus(v as PositionStatus)}
                      >
                        <SelectTrigger id="pos-status">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUS_OPTIONS.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="primary"
                        size="md"
                        onClick={save}
                        disabled={!dirty}
                      >
                        <Check size={13} /> Save changes
                      </Button>
                      {info.item && (
                        <Button
                          type="button"
                          variant="default"
                          size="md"
                          onClick={() => setConfirmMove(true)}
                        >
                          <ArrowRightLeft size={13} /> Move to…
                        </Button>
                      )}
                    </div>
                  </div>
                </section>
              )}

              {/* Tip */}
              <p
                className={cn(
                  'rounded-md border border-border bg-surface px-3 py-2.5 text-xs text-text-2',
                )}
              >
                <strong className="text-text">Tip:</strong> Use &ldquo;Move to…&rdquo; to relocate
                this item to another position without changing inventory totals.
              </p>

              {/* Audit footnote */}
              <div className="rounded-md border border-border bg-bg-elev p-3 text-xs text-text-3">
                <div className="mb-1 inline-flex items-center gap-1.5 font-medium text-text-2">
                  <ShieldCheck size={12} /> Audit
                </div>
                Every change to this position is signed and logged with username + timestamp.
              </div>
            </SheetBody>
          </>
        )}
      </SheetContent>

      <ConfirmDialog
        open={confirmEmpty}
        onOpenChange={setConfirmEmpty}
        title="Empty this position?"
        description={
          info?.item
            ? `${info.item.desc} will be unassigned from position ${info.index}. Inventory totals are not affected.`
            : `Position ${info?.index ?? ''} will be cleared and made available for assignment.`
        }
        confirmLabel="Empty position"
        variant="danger"
        onConfirm={emptyPosition}
      />

      <ConfirmDialog
        open={confirmMove}
        onOpenChange={setConfirmMove}
        title="Move this item?"
        description="Choose a destination position from the map. (Demo: relocation is queued — no real move is performed.)"
        confirmLabel="Queue move"
        onConfirm={async () => {
          await new Promise((r) => setTimeout(r, 200));
          toast.success('Move queued');
        }}
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
