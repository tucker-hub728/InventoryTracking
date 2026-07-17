'use client';

import * as React from 'react';
import { ArrowRight, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';

import { ItemCell, LocationSelect, NumberInput, QtyCell, RuleNote, Stat } from './recon-bits';
import { PRODUCTION_LOCATIONS, itemOf, onHandAt, type Kit, type KitLine } from './reconciliation-data';
import { lineIssuedTotal } from './reconciliation-engine';
import { useReconStore } from './reconciliation-store';

/**
 * Issue tab. Quantity Issued is a manual entry (Transaction Spec §2) —
 * pre-filled from the BOM but freely editable while the kit is a Draft.
 * Issuing decrements the source location and moves material to the production
 * location.
 */
export function KitIssueTab({
  kit,
  actor,
  onIssue,
}: {
  kit: Kit;
  actor: string;
  onIssue: () => void;
}) {
  const stock = useReconStore((s) => s.stock);
  const setLineIssued = useReconStore((s) => s.setLineIssued);
  const setLineSource = useReconStore((s) => s.setLineSource);
  const setProductionLocation = useReconStore((s) => s.setProductionLocation);

  const [addingTo, setAddingTo] = React.useState<KitLine | null>(null);

  const isDraft = kit.status === 'draft';
  const canAddMore = kit.status === 'issued' || kit.status === 'in_production';

  const sourceOptions = React.useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const line of kit.lines) {
      const locs = Object.entries(stock[line.itemId] ?? {})
        .filter(([, q]) => q > 0)
        .map(([l]) => l);
      out[line.itemId] = locs.length ? locs : [line.sourceLocation];
    }
    return out;
  }, [kit.lines, stock]);

  const totalIssued = kit.lines.reduce((a, l) => a + lineIssuedTotal(l), 0);
  const overIssued = kit.lines.filter((l) => lineIssuedTotal(l) > l.qtyNeeded).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Total issued" value={totalIssued} hint="Units out of storage" />
        <Stat
          label="Lines over BOM"
          value={overIssued}
          tone={overIssued > 0 ? 'warning' : 'default'}
          hint="Issued more than Needed"
        />
        <Stat label="Issued to" value={kit.productionLocation} hint="Production location" />
        <Stat
          label="Issued at"
          value={kit.issuedAt ? new Date(kit.issuedAt).toLocaleDateString() : '—'}
          hint={isDraft ? 'Not issued yet' : 'Stock already decremented'}
        />
      </div>

      {isDraft && (
        <Card className="p-4">
          <label htmlFor="prod-loc" className="mb-1.5 block text-xs font-medium text-text-2">
            Production location
          </label>
          <div className="max-w-xs">
            <LocationSelect
              aria-label="Production location"
              value={kit.productionLocation}
              options={PRODUCTION_LOCATIONS}
              onChange={(v) => setProductionLocation(kit.id, v)}
              className="h-8 text-sm"
            />
          </div>
          <p className="mt-1.5 text-xs text-text-3">
            Transaction Spec §2: an item&apos;s location must move from its storage location to the
            production location it is kitted to.
          </p>
        </Card>
      )}

      <Card className="p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-text">Kit structure</h2>
            <p className="mt-0.5 text-xs text-text-3">
              {isDraft
                ? 'Quantity Needed comes from the BOM. Quantity Issued is what you actually pull — edit it before issuing.'
                : 'Issued and locked. Extra material during production goes through an additional issue.'}
            </p>
          </div>
          {isDraft && (
            <Button variant="primary" onClick={onIssue}>
              Issue material <ArrowRight size={14} />
            </Button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Needed</th>
                <th className="px-3 py-2 text-right font-medium">Issued</th>
                <th className="px-3 py-2 text-right font-medium">Additional</th>
                <th className="px-3 py-2 font-medium">Source location</th>
                <th className="px-3 py-2 text-right font-medium">On hand there</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {kit.lines.map((line) => {
                const have = onHandAt(stock, line.itemId, line.sourceLocation);
                const short = isDraft && line.qtyIssued > have;
                return (
                  <tr key={line.itemId} className="border-b border-border/60">
                    <td className="max-w-[320px] px-3 py-2">
                      <ItemCell itemId={line.itemId} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <QtyCell value={line.qtyNeeded} title={`×${line.qtyPerUnit} per unit`} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isDraft ? (
                        <NumberInput
                          aria-label={`Quantity issued for ${line.itemId}`}
                          value={line.qtyIssued}
                          invalid={short}
                          onChange={(v) => setLineIssued(kit.id, line.itemId, v ?? 0)}
                        />
                      ) : (
                        <QtyCell
                          value={line.qtyIssued}
                          tone={line.qtyIssued > line.qtyNeeded ? 'success' : undefined}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <QtyCell value={line.qtyAdditional || null} tone={line.qtyAdditional ? 'success' : 'muted'} />
                    </td>
                    <td className="px-3 py-2">
                      {isDraft ? (
                        <div className="w-44">
                          <LocationSelect
                            aria-label={`Source location for ${line.itemId}`}
                            value={line.sourceLocation}
                            options={sourceOptions[line.itemId] ?? []}
                            onChange={(v) => setLineSource(kit.id, line.itemId, v)}
                          />
                        </div>
                      ) : (
                        <span className="text-xs text-text-2">{line.sourceLocation}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <QtyCell value={have} tone={short ? 'danger' : undefined} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canAddMore && (
                        <Button variant="ghost" size="sm" onClick={() => setAddingTo(line)}>
                          <Plus size={12} /> Issue more
                        </Button>
                      )}
                      {short && (
                        <Badge tone="danger" className="ml-1">
                          Short {line.qtyIssued - have}
                        </Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <RuleNote>
        Issuing removes the quantity from the source location immediately: if 50 are on hand and 25
        are kitted, the item reports 25 on hand (REQ-2026-07-09-TRX-001). Every line here is a
        product item and stays reconcilable — leftovers come back at close-out as a back-flush.
        Consumables are never part of a BOM, so they never appear on a kit (Transaction Spec §4.3);
        they are handled on the Consumables tab.
      </RuleNote>

      <AdditionalIssueDialog
        kit={kit}
        line={addingTo}
        actor={actor}
        onOpenChange={(o) => {
          if (!o) setAddingTo(null);
        }}
      />
    </div>
  );
}

/** The edit function Transaction Spec §2.1 requires: more material can be
 *  issued to a kit mid-production. */
function AdditionalIssueDialog({
  kit,
  line,
  actor,
  onOpenChange,
}: {
  kit: Kit;
  line: KitLine | null;
  actor: string;
  onOpenChange: (open: boolean) => void;
}) {
  const stock = useReconStore((s) => s.stock);
  const additionalIssue = useReconStore((s) => s.additionalIssue);
  const [qty, setQty] = React.useState<number | null>(1);

  React.useEffect(() => {
    if (line) setQty(1);
  }, [line?.itemId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!line) return null;
  const item = itemOf(line.itemId);
  const have = onHandAt(stock, line.itemId, line.sourceLocation);

  const submit = () => {
    if (!qty || qty <= 0) {
      toast.error('Enter a quantity greater than 0.');
      return;
    }
    if (additionalIssue(kit.id, line.itemId, qty, actor)) {
      toast.success('Additional material issued', {
        description: `${qty} × ${line.itemId} to ${kit.productionLocation}.`,
      });
      onOpenChange(false);
    } else {
      toast.error('Could not issue', { description: useReconStore.getState().lastError ?? undefined });
    }
  };

  return (
    <Dialog open={line !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Issue more to {kit.id}</DialogTitle>
          <DialogDescription>
            Production needed extra {item.id}. This posts as a separate additional issue so the
            ledger shows where the material came from.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="rounded-md border border-border bg-surface p-3">
            <ItemCell itemId={line.itemId} />
          </div>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div>
              <div className="text-text-3">Already issued</div>
              <div className="mt-0.5 font-mono tabular-nums text-text">{lineIssuedTotal(line)}</div>
            </div>
            <div>
              <div className="text-text-3">On hand at {line.sourceLocation}</div>
              <div className={cn('mt-0.5 font-mono tabular-nums', have > 0 ? 'text-text' : 'text-danger')}>
                {have}
              </div>
            </div>
            <div>
              <div className="text-text-3">Issue now</div>
              <NumberInput
                aria-label="Additional quantity"
                value={qty}
                min={1}
                invalid={(qty ?? 0) > have}
                onChange={setQty}
                className="mt-0.5"
              />
            </div>
          </div>
          {(qty ?? 0) > have && (
            <p className="text-xs text-danger">Only {have} on hand at {line.sourceLocation}.</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!qty || qty <= 0 || qty > have}>
            Issue {qty ?? 0}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
