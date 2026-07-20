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
import { ApiError } from '@/lib/api/client';
import { itemsApi, type ApiItem } from '@/lib/api/items';
import { kitsApi } from '@/lib/api/kits';
import { isBuiltTier } from '@/lib/api/tiers';

import { LocationTreePicker } from './location-tree-picker';
import { NumberInput, RuleNote } from './recon-bits';

/**
 * Open a kit ad-hoc: pick a buildable item (sub-assembly / finished good that
 * has a BOM), a quantity, and a production floor. The backend explodes the BOM
 * into the kit's lines.
 */
export function NewKitDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}) {
  const router = useRouter();

  const [items, setItems] = React.useState<ApiItem[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [itemId, setItemId] = React.useState('');
  const [targetQty, setTargetQty] = React.useState<number | null>(3);
  const [prodNodeId, setProdNodeId] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoadError(null);
    setError(null);
    setTargetQty(3);
    setProdNodeId('');
    void (async () => {
      try {
        const itemRes = await itemsApi.list(
          { has_bom: true, limit: 200 },
          { signal: ctrl.signal },
        );
        const buildable = itemRes.items.filter((i) => isBuiltTier(i.tier_type));
        setItems(buildable);
        setItemId(buildable[0]?.id ?? '');
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load items.');
      }
    })();
    return () => ctrl.abort();
  }, [open]);

  const submit = async () => {
    if (!itemId) {
      setError('Pick an item to build.');
      return;
    }
    if (!prodNodeId) {
      setError('Pick a production location.');
      return;
    }
    if (!targetQty || targetQty < 1) {
      setError('Enter a build quantity of 1 or more.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const kit = await kitsApi.create({
        item_id: itemId,
        target_qty: targetQty,
        production_location_node_id: prodNodeId,
      });
      toast.success(`${kit.kit_number} opened`, {
        description: `Draft to build ${targetQty} × ${kit.item_number}.`,
      });
      onOpenChange(false);
      onCreated?.();
      router.push(`/reconciliation/${kit.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the kit.');
    } finally {
      setSubmitting(false);
    }
  };

  const selected = items.find((i) => i.id === itemId);
  const noBuildable = !loadError && items.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New kit</DialogTitle>
          <DialogDescription>
            Pick a sub-assembly or finished good to build. The bill of materials explodes into the
            kit&apos;s lines.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {loadError ? (
            <p className="text-sm text-danger">{loadError}</p>
          ) : noBuildable ? (
            <RuleNote>
              No buildable items found — a kit needs a sub-assembly or finished good that has a bill
              of materials. Define a BOM first, then open a kit.
            </RuleNote>
          ) : (
            <>
              <div>
                <label htmlFor="kit-item" className="mb-1.5 block text-xs font-medium text-text-2">
                  Build
                </label>
                <select
                  id="kit-item"
                  value={itemId}
                  onChange={(e) => setItemId(e.target.value)}
                  className="h-8 w-full rounded-md border border-border-strong bg-bg-elev px-2 text-sm text-text outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
                >
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.item_number} — {i.description}
                    </option>
                  ))}
                </select>
                {selected && (
                  <p className="mt-1 text-xs text-text-3">
                    {selected.bom_line_count} component
                    {selected.bom_line_count === 1 ? '' : 's'} in the BOM.
                  </p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="kit-qty" className="mb-1.5 block text-xs font-medium text-text-2">
                    Build quantity
                  </label>
                  <NumberInput
                    aria-label="Build quantity"
                    value={targetQty}
                    min={1}
                    onChange={setTargetQty}
                    className="h-8 w-full text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="kit-loc" className="mb-1.5 block text-xs font-medium text-text-2">
                    Production location
                  </label>
                  <LocationTreePicker
                    aria-label="Production location"
                    value={prodNodeId}
                    onChange={setProdNodeId}
                    areas={['cold', 'warehouse']}
                    modal
                    showPath
                  />
                </div>
              </div>

              <RuleNote>
                Material transfers here from its storage location when the kit is issued. Issued
                quantities default to what the BOM needs — you can adjust them on the kit before
                issuing.
              </RuleNote>

              {error && <p className="text-xs text-danger">{error}</p>}
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={submitting || noBuildable}>
            {submitting ? 'Opening…' : 'Open kit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
