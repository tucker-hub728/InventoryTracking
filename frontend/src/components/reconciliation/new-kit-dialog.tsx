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
import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
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

  const [kitNumber, setKitNumber] = React.useState('');
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
    setKitNumber('');
    // Pre-fill a free KIT-#### so the field is never blank; the operator
    // overwrites it with the traveler's batch number when they have one.
    void kitsApi
      .nextNumber({ signal: ctrl.signal })
      .then((r) => setKitNumber((cur) => cur || r.kit_number))
      .catch(() => {});
    void (async () => {
      try {
        // Only items you can actually gather a kit for: a built tier (AY/FG)
        // whose BOM has at least two components. Transaction_Spec §1.1 composes
        // every built item from two inputs, so a one-line BOM is an unfinished
        // recipe. The backend enforces the same rule on create.
        const itemRes = await itemsApi.list(
          { has_bom: true, min_bom_lines: 2, limit: 200 },
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
    if (!kitNumber.trim()) {
      setError('Enter a kit / batch name.');
      return;
    }
    if (!itemId) {
      setError('Pick an item to build.');
      return;
    }
    if (!prodNodeId) {
      setError('Pick a production location.');
      return;
    }
    if (!targetQty || targetQty < 1) {
      setError('Enter a target quantity of 1 or more.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const kit = await kitsApi.create({
        kit_number: kitNumber.trim(),
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

  // Buildable items can run long once a catalog fills out, so the picker is the
  // searchable one rather than a plain dropdown.
  const itemOptions = React.useMemo(
    () =>
      items.map((i) => ({
        value: i.id,
        label: (
          <span className="flex items-center gap-2">
            <span className="font-mono">{i.item_number}</span>
            <span className="truncate text-text-2">{i.description}</span>
          </span>
        ),
        searchText: `${i.item_number} ${i.description}`,
      })),
    [items],
  );

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
                <label htmlFor="kit-name" className="mb-1.5 block text-xs font-medium text-text-2">
                  Kit / batch name
                </label>
                <Input
                  id="kit-name"
                  aria-label="Kit / batch name"
                  value={kitNumber}
                  onChange={(e) => setKitNumber(e.target.value)}
                  placeholder="e.g. BR-2026-014"
                />
                <p className="mt-1 text-xs text-text-3">
                  Use the batch or traveler number if you have one. This also names the lot the
                  finished quantity is stocked under.
                </p>
              </div>
              <div>
                <label htmlFor="kit-item" className="mb-1.5 block text-xs font-medium text-text-2">
                  Item
                </label>
                <SearchableSelect
                  id="kit-item"
                  aria-label="Item"
                  modal
                  options={itemOptions}
                  value={itemId}
                  onChange={setItemId}
                  placeholder="Choose an item"
                  searchPlaceholder="Search by number or description…"
                  emptyText="No buildable items match."
                />
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
                    Target quantity
                  </label>
                  <NumberInput
                    aria-label="Target quantity"
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
                    // Transaction_Spec §2: material is moved to a production or
                    // manufacturing location at kitting, so only those are valid
                    // here — a warehouse shelf is not a production floor.
                    areas={['production']}
                    modal
                    placeholder="Choose a production floor"
                    emptyText="No production or lab floors are set up."
                  />
                  <p className="mt-1 text-xs text-text-3">
                    Issued material moves here and is held as work-in-progress until close-out.
                  </p>
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
