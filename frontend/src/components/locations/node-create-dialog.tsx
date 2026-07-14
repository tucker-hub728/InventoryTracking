'use client';

import * as React from 'react';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { customersApi, type Customer } from '@/lib/api/customers';
import { itemsApi } from '@/lib/api/items';
import {
  locationNodesApi,
  CHILD_TYPES_OF,
  NODE_TYPE_LABEL,
  type CreatableNodeType,
  type LocationNode,
} from '@/lib/api/location-nodes';

type Mode =
  | { kind: 'ln2-root' }
  | { kind: 'child'; parent: LocationNode };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  onCreated: (node: LocationNode) => void;
}

type DedicationKind = 'none' | 'customer' | 'product';

/**
 * Temporary client-side code generator. The Code field was removed from the
 * UI — only the name is user-entered — but the backend still requires a
 * non-blank code that's unique among siblings.
 */
function autoCode(name: string): string {
  const base = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/(^-+)|(-+$)/g, '')
    .slice(0, 50);
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `${base || 'NODE'}-${suffix}`;
}

/** Create a tank quadrant (root, optionally dedicated), an LN2 child node
 *  (cassette / cryo box rack under a rack, or a grid-bearing box), or a flat
 *  location. */
export function NodeCreateDialog({ open, onOpenChange, mode, onCreated }: Props) {
  const [name, setName] = React.useState('');
  // For a rack child the user chooses cassette vs cryo_box_rack.
  const childOptions = mode.kind === 'child' ? CHILD_TYPES_OF[mode.parent.node_type] : [];
  const [childType, setChildType] = React.useState<CreatableNodeType>(
    childOptions[0] ?? 'box',
  );
  // Box grid dimensions.
  const [gridRows, setGridRows] = React.useState('10');
  const [gridCols, setGridCols] = React.useState('10');
  // Quadrant dedication.
  const [dedKind, setDedKind] = React.useState<DedicationKind>('none');
  const [dedTarget, setDedTarget] = React.useState('');
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [products, setProducts] = React.useState<{ id: string; name: string }[]>([]);

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Resolve the node type being created.
  const nodeType: CreatableNodeType | null =
    mode.kind === 'ln2-root'
      ? 'tank_quadrant'
      : childOptions.length === 0
        ? null
        : childOptions.length === 1
          ? (childOptions[0] ?? null)
          : childType;

  const isBox = nodeType === 'box';
  const isQuadrant = nodeType === 'tank_quadrant';
  // A box directly under a cassette is single-column.
  const parentIsCassette =
    mode.kind === 'child' && mode.parent.node_type === 'cassette';

  React.useEffect(() => {
    if (!open) {
      setName('');
      setChildType(childOptions[0] ?? 'box');
      setGridRows('10');
      setGridCols('10');
      setDedKind('none');
      setDedTarget('');
      setSubmitting(false);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Lock a cassette box to a single column.
  React.useEffect(() => {
    if (isBox && parentIsCassette) setGridCols('1');
  }, [isBox, parentIsCassette]);

  // Load customers / products only when creating a quadrant (for dedication).
  React.useEffect(() => {
    if (!open || !isQuadrant) return;
    const ctrl = new AbortController();
    Promise.all([
      customersApi.list({}, { signal: ctrl.signal }).catch(() => []),
      itemsApi
        .list({ limit: 200 }, { signal: ctrl.signal })
        .then((resp) =>
          resp.items
            .filter((i) => i.category_kind === 'built')
            .map((i) => ({ id: i.id, name: `${i.item_number} · ${i.description}` })),
        )
        .catch(() => []),
    ]).then(([cs, ps]) => {
      setCustomers(cs);
      setProducts(ps);
    });
    return () => ctrl.abort();
  }, [open, isQuadrant]);

  const title =
    mode.kind === 'ln2-root'
      ? 'Add Tank Quadrant'
      : `Add ${nodeType ? NODE_TYPE_LABEL[nodeType] : 'child'}`;

  const submit = async () => {
    if (!nodeType) return;
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }

    let rows: number | null = null;
    let cols: number | null = null;
    if (isBox) {
      rows = Number(gridRows);
      cols = Number(gridCols);
      if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
        setError('Grid rows and columns must be whole numbers ≥ 1.');
        return;
      }
      if (parentIsCassette && cols !== 1) {
        setError('A box under a cassette is single-column (columns = 1).');
        return;
      }
    }

    let dedCustomer: string | null = null;
    let dedProduct: string | null = null;
    if (isQuadrant && dedKind !== 'none') {
      if (!dedTarget) {
        setError(`Pick a ${dedKind} to dedicate this quadrant to.`);
        return;
      }
      if (dedKind === 'customer') dedCustomer = dedTarget;
      else dedProduct = dedTarget;
    }

    setSubmitting(true);
    try {
      const node = await locationNodesApi.create({
        node_type: nodeType,
        code: autoCode(name),
        name: name.trim(),
        parent_id: mode.kind === 'child' ? mode.parent.id : null,
        grid_rows: rows,
        grid_cols: cols,
        dedicated_customer_id: dedCustomer,
        dedicated_product_id: dedProduct,
      });
      toast.success(`${NODE_TYPE_LABEL[nodeType]} created`, { description: node.name });
      onCreated(node);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create node.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode.kind === 'child'
              ? `Under ${NODE_TYPE_LABEL[mode.parent.node_type]} ${mode.parent.name}.`
              : 'A top-level LN2 node. Build the hierarchy down to boxes.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {/* Cassette vs Cryo Box Rack choice (rack children only). */}
          {mode.kind === 'child' && childOptions.length > 1 && (
            <div className="space-y-1.5">
              <Label>Container type</Label>
              <Select
                value={childType}
                onValueChange={(v) => setChildType(v as CreatableNodeType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {childOptions.map((c) => (
                    <SelectItem key={c} value={c}>
                      {NODE_TYPE_LABEL[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-text-3">
                Cassette = single-column of boxes · Cryo Box Rack = grid of boxes.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>
              Name <span className="text-danger">*</span>
            </Label>
            <Input
              autoFocus
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Box grid dimensions. */}
          {isBox && (
            <div className="space-y-1.5">
              <Label>
                Grid size <span className="text-danger">*</span>
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  step="1"
                  aria-label="Rows"
                  value={gridRows}
                  onChange={(e) => setGridRows(e.target.value)}
                  className="w-20 font-mono"
                />
                <span className="text-text-3">×</span>
                <Input
                  type="number"
                  min={1}
                  step="1"
                  aria-label="Columns"
                  value={gridCols}
                  disabled={parentIsCassette}
                  onChange={(e) => setGridCols(e.target.value)}
                  className="w-20 font-mono"
                />
                <span className="text-xs text-text-3">rows × columns</span>
              </div>
              {parentIsCassette && (
                <p className="text-xs text-text-3">
                  A cassette box is a single column — set the number of rows.
                </p>
              )}
            </div>
          )}

          {/* Quadrant dedication. */}
          {isQuadrant && (
            <div className="space-y-1.5">
              <Label>Dedicate to (optional)</Label>
              <Select
                value={dedKind}
                onValueChange={(v) => {
                  setDedKind(v as DedicationKind);
                  setDedTarget('');
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not dedicated</SelectItem>
                  <SelectItem value="customer">Customer</SelectItem>
                  <SelectItem value="product">Product</SelectItem>
                </SelectContent>
              </Select>
              {dedKind === 'customer' && (
                <Select value={dedTarget} onValueChange={setDedTarget}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select customer" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {dedKind === 'product' && (
                <Select value={dedTarget} onValueChange={setDedTarget}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select product" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-text-3">
                Advisory only — descendants inherit it; placement is never blocked.
              </p>
            </div>
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
          <Button type="button" variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
