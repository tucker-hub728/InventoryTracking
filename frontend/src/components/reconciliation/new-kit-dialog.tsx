'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

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
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';

import { ItemCell, LocationSelect, NumberInput, RuleNote } from './recon-bits';
import {
  BOM,
  PRODUCTION_LOCATIONS,
  buildableItems,
  itemOf,
  onHandTotal,
} from './reconciliation-data';
import { useReconStore } from './reconciliation-store';

const ACTOR = 'Jordan Okafor';

/**
 * Open a kit ad-hoc: pick a buildable item and a quantity, and the BOM explodes
 * into Qty Needed (qtyPerUnit × buildQty) per Transaction Spec §2. Planning
 * (REQ-2026-07-09-PLN-001) would be the other entry point, but it isn't built.
 */
export function NewKitDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const stock = useReconStore((s) => s.stock);
  const createKit = useReconStore((s) => s.createKit);
  const lastError = useReconStore((s) => s.lastError);

  const options = React.useMemo(() => buildableItems(), []);
  const [parentId, setParentId] = React.useState<string>(options[0]?.id ?? '');
  const [buildQty, setBuildQty] = React.useState<number | null>(3);
  const [location, setLocation] = React.useState<string>(PRODUCTION_LOCATIONS[0]);

  React.useEffect(() => {
    if (!open) return;
    setParentId(options[0]?.id ?? '');
    setBuildQty(3);
    setLocation(PRODUCTION_LOCATIONS[0]);
  }, [open, options]);

  const preview = React.useMemo(() => {
    if (!parentId || !buildQty || buildQty < 1) return [];
    return (BOM[parentId] ?? []).map((line) => {
      const needed = line.qtyPerUnit * buildQty;
      const have = onHandTotal(stock, line.childId);
      return { ...line, needed, have, short: Math.max(0, needed - have) };
    });
  }, [parentId, buildQty, stock]);

  const shortages = preview.filter((p) => p.short > 0);

  const submit = () => {
    if (!buildQty || buildQty < 1) {
      toast.error('Enter a build quantity of 1 or more.');
      return;
    }
    const id = createKit({
      parentItemId: parentId,
      buildQty,
      productionLocation: location,
      actor: ACTOR,
    });
    if (!id) {
      toast.error('Could not open kit', { description: useReconStore.getState().lastError ?? undefined });
      return;
    }
    toast.success(`${id} opened`, {
      description: `Draft to build ${buildQty} × ${parentId}. Nothing has moved yet.`,
    });
    onOpenChange(false);
    router.push(`/reconciliation/${id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New kit</DialogTitle>
          <DialogDescription>
            Pick what to build. Quantity Needed explodes from the bill of materials; you enter
            Quantity Issued on the kit itself.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label
                htmlFor="kit-parent"
                className="mb-1.5 block text-xs font-medium text-text-2"
              >
                Build
              </label>
              <select
                id="kit-parent"
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
                className="h-8 w-full rounded-md border border-border-strong bg-bg-elev px-2 text-sm text-text outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
              >
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.tier} · {o.id} — {o.desc}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="kit-qty" className="mb-1.5 block text-xs font-medium text-text-2">
                Build quantity
              </label>
              <NumberInput
                aria-label="Build quantity"
                value={buildQty}
                min={1}
                onChange={setBuildQty}
                className="h-8 w-full text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="kit-loc" className="mb-1.5 block text-xs font-medium text-text-2">
              Production location
            </label>
            <LocationSelect
              aria-label="Production location"
              value={location}
              options={PRODUCTION_LOCATIONS}
              onChange={setLocation}
              className="h-8 text-sm"
            />
            <p className="mt-1.5 text-xs text-text-3">
              Material transfers here from its storage location when the kit is issued.
            </p>
          </div>

          {preview.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium text-text-2">
                Exploded bill of materials
              </div>
              <div className="max-h-60 overflow-y-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                      <th className="px-3 py-2 font-medium">Item</th>
                      <th className="px-3 py-2 text-right font-medium">Per unit</th>
                      <th className="px-3 py-2 text-right font-medium">Needed</th>
                      <th className="px-3 py-2 text-right font-medium">On hand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((p) => (
                      <tr key={p.childId} className="border-b border-border/60 last:border-0">
                        <td className="max-w-[300px] px-3 py-2">
                          <ItemCell itemId={p.childId} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-text-3">
                          ×{p.qtyPerUnit}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs font-medium tabular-nums">
                          {p.needed}
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2 text-right font-mono text-xs tabular-nums',
                            p.short > 0 ? 'font-medium text-danger' : 'text-text-2',
                          )}
                        >
                          {p.have}
                          {p.short > 0 && (
                            <span className="ml-1 text-[11px]">(short {p.short})</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {shortages.length > 0 && (
            <RuleNote>
              <span className="font-medium text-warning">
                {shortages.length === 1 ? 'One line is' : `${shortages.length} lines are`} short.
              </span>{' '}
              You can still open the kit as a Draft — nothing moves until you issue it. A
              sub-assembly that is short has to be built by its own kit first: an AY only gains stock
              by being produced (Transaction Spec §3.1).
            </RuleNote>
          )}

          {itemOf(parentId).tier === 'FG' && (
            <RuleNote>
              This finished good consumes sub-assemblies. Their own recipes show on the kit as a
              read-only tree — this kit consumes AY stock, it does not explode the AY&apos;s BOM.
            </RuleNote>
          )}

          {lastError && <p className="text-xs text-danger">{lastError}</p>}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Open kit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
