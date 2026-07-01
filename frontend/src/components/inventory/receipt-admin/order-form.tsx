'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '@/components/ui/searchable-select';
import { itemsApi, type ApiItem, type ApiItemSupplier } from '@/lib/api/items';
import type { Order, OrderLineInput } from '@/lib/api/receiving';

// ── Draft model ────────────────────────────────────────────────────────────

export interface OrderLineDraft {
  key: string;
  item_id: string;
  supplierChoice: string; // supplier id | ''
  ordered_qty: string;
  unit_price: string;
  // Suppliers available for this line's selected item.
  suppliers: ApiItemSupplier[];
  suppliersLoading: boolean;
}

export interface OrderFormState {
  po_reference: string;
  is_blanket: boolean;
  valid_from: string;
  valid_to: string;
  lines: OrderLineDraft[];
}

let _seq = 0;
function nextKey(): string {
  _seq += 1;
  return `line-${_seq}`;
}

export function emptyLine(): OrderLineDraft {
  return {
    key: nextKey(),
    item_id: '',
    supplierChoice: '',
    ordered_qty: '',
    unit_price: '',
    suppliers: [],
    suppliersLoading: false,
  };
}

export function emptyFormState(): OrderFormState {
  return {
    po_reference: '',
    is_blanket: false,
    valid_from: '',
    valid_to: '',
    lines: [emptyLine()],
  };
}

/** Seed a form state from an existing Order (for editing). */
export function formStateFromOrder(order: Order): OrderFormState {
  return {
    po_reference: order.po_reference,
    is_blanket: order.is_blanket,
    valid_from: order.valid_from ?? '',
    valid_to: order.valid_to ?? '',
    lines: order.lines.map((l) => ({
      key: nextKey(),
      item_id: l.item_id,
      supplierChoice: l.supplier_id,
      ordered_qty: String(l.ordered_qty),
      unit_price: l.unit_price_amount ?? '',
      // Seed with the line's own supplier so the Select shows a label before the
      // item's full supplier list resolves; the loader replaces it.
      suppliers: [{ supplier_id: l.supplier_id, supplier_name: l.supplier_name ?? '' }],
      suppliersLoading: false,
    })),
  };
}

/** Validate the form and build an OrderCreateInput-style payload, or return an
 *  error message. Lines are returned as OrderLineInput[]. */
export function validateOrderForm(
  state: OrderFormState,
): { lines: OrderLineInput[] } | { error: string } {
  if (!state.po_reference.trim()) {
    return { error: 'Order # is required.' };
  }
  if (state.is_blanket && state.valid_from && state.valid_to && state.valid_to < state.valid_from) {
    return { error: 'Valid-to must be on or after valid-from.' };
  }
  if (state.lines.length === 0) {
    return { error: 'Add at least one item line.' };
  }
  const lines: OrderLineInput[] = [];
  for (let i = 0; i < state.lines.length; i += 1) {
    const l = state.lines[i];
    if (!l) continue;
    const n = i + 1;
    if (!l.item_id) {
      return { error: `Line ${n}: pick an item.` };
    }
    if (!l.supplierChoice) {
      return { error: `Line ${n}: pick a supplier.` };
    }
    const qty = Number(l.ordered_qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      return { error: `Line ${n}: ordered qty must be greater than 0.` };
    }
    let unitPrice: number | undefined;
    if (l.unit_price.trim() !== '') {
      const p = Number(l.unit_price);
      if (!Number.isFinite(p) || p < 0) {
        return { error: `Line ${n}: unit price must be a non-negative number.` };
      }
      unitPrice = p;
    }
    lines.push({
      item_id: l.item_id,
      supplier_id: l.supplierChoice,
      ordered_qty: qty,
      unit_price: unitPrice,
    });
  }
  return { lines };
}

// ── Shared form UI ──────────────────────────────────────────────────────────

interface OrderFormProps {
  items: ApiItem[];
  itemsLoading: boolean;
  state: OrderFormState;
  setState: React.Dispatch<React.SetStateAction<OrderFormState>>;
  idPrefix: string;
}

/** Header (Order #, blanket window) + repeatable item lines. Shared by
 *  the New Order and Edit Order dialogs. Supplier options are loaded per line
 *  from the line's selected item. */
export function OrderForm({
  items,
  itemsLoading,
  state,
  setState,
  idPrefix,
}: OrderFormProps) {
  const patchLine = React.useCallback(
    (key: string, patch: Partial<OrderLineDraft>) =>
      setState((prev) => ({
        ...prev,
        lines: prev.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
      })),
    [setState],
  );

  // Load the selected item's suppliers for a line, clearing the prior choice.
  const onItemChange = React.useCallback(
    (key: string, itemId: string) => {
      patchLine(key, {
        item_id: itemId,
        supplierChoice: '',
        suppliers: [],
        suppliersLoading: !!itemId,
      });
      if (!itemId) return;
      itemsApi
        .listSuppliers(itemId)
        .then((suppliers) =>
          setState((prev) => ({
            ...prev,
            lines: prev.lines.map((l) =>
              l.key === key ? { ...l, suppliers, suppliersLoading: false } : l,
            ),
          })),
        )
        .catch(() =>
          setState((prev) => ({
            ...prev,
            lines: prev.lines.map((l) =>
              l.key === key ? { ...l, suppliers: [], suppliersLoading: false } : l,
            ),
          })),
        );
    },
    [patchLine, setState],
  );

  const addLine = () =>
    setState((prev) => ({ ...prev, lines: [...prev.lines, emptyLine()] }));

  const removeLine = (key: string) =>
    setState((prev) => ({
      ...prev,
      lines: prev.lines.filter((l) => l.key !== key),
    }));

  // Searchable item options (item number + description both match the query).
  const itemOptions = React.useMemo<SearchableSelectOption[]>(
    () =>
      items.map((i) => ({
        value: i.id,
        label: (
          <>
            <span className="font-mono text-xs">{i.item_number}</span>
            <span className="ml-2 text-text-2">{i.description}</span>
          </>
        ),
        searchText: `${i.item_number} ${i.description}`,
      })),
    [items],
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-po`}>
            Order # <span className="text-danger">*</span>
          </Label>
          <Input
            id={`${idPrefix}-po`}
            placeholder="PO-2026-0042"
            value={state.po_reference}
            onChange={(e) =>
              setState((prev) => ({ ...prev, po_reference: e.target.value }))
            }
          />
        </div>
        <div className="flex items-end pb-1.5">
          <label className="inline-flex items-center gap-2 text-sm text-text-2">
            <input
              type="checkbox"
              className="size-4 rounded border-border-strong accent-accent"
              checked={state.is_blanket}
              onChange={(e) =>
                setState((prev) => ({ ...prev, is_blanket: e.target.checked }))
              }
            />
            Blanket order
          </label>
        </div>
      </div>

      {state.is_blanket && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-from`}>Valid from</Label>
            <Input
              id={`${idPrefix}-from`}
              type="date"
              value={state.valid_from}
              onChange={(e) =>
                setState((prev) => ({ ...prev, valid_from: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-to`}>Valid to</Label>
            <Input
              id={`${idPrefix}-to`}
              type="date"
              value={state.valid_to}
              onChange={(e) =>
                setState((prev) => ({ ...prev, valid_to: e.target.value }))
              }
            />
          </div>
        </div>
      )}

      <Separator />

      <div className="space-y-3">
        {state.lines.map((line, idx) => (
          <div
            key={line.key}
            className="rounded-md border border-border bg-surface p-3"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-text-2">
                Item {idx + 1}
              </span>
              {state.lines.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeLine(line.key)}
                  aria-label="Remove item line"
                >
                  <Trash2 size={14} />
                </Button>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>
                Item <span className="text-danger">*</span>
              </Label>
              <SearchableSelect
                aria-label="Item"
                options={itemOptions}
                value={line.item_id}
                onChange={(v) => onItemChange(line.key, v)}
                disabled={itemsLoading || items.length === 0}
                placeholder={itemsLoading ? 'Loading…' : 'Select item'}
                searchPlaceholder="Search by item number or description…"
                emptyText="No matching items."
              />
            </div>

            <div className="mt-3 grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>
                  Supplier <span className="text-danger">*</span>
                </Label>
                <SearchableSelect
                  aria-label="Supplier"
                  options={line.suppliers.map((v) => ({
                    value: v.supplier_id,
                    label: v.supplier_name,
                    searchText: v.supplier_name,
                  }))}
                  value={line.supplierChoice}
                  onChange={(v) => patchLine(line.key, { supplierChoice: v })}
                  disabled={!line.item_id || line.suppliersLoading}
                  placeholder={
                    !line.item_id
                      ? 'Pick an item first'
                      : line.suppliersLoading
                        ? 'Loading…'
                        : line.suppliers.length > 0
                          ? 'Select supplier'
                          : 'Item has no suppliers'
                  }
                  searchPlaceholder="Search suppliers…"
                  emptyText="No matching suppliers."
                />
              </div>
              <div className="space-y-1.5">
                <Label>
                  Ordered qty <span className="text-danger">*</span>
                </Label>
                <Input
                  type="number"
                  min={0}
                  step="1"
                  value={line.ordered_qty}
                  onChange={(e) =>
                    patchLine(line.key, { ordered_qty: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>Unit price</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="0.00"
                  value={line.unit_price}
                  onChange={(e) =>
                    patchLine(line.key, { unit_price: e.target.value })
                  }
                />
              </div>
            </div>

            {line.item_id && !line.suppliersLoading && line.suppliers.length === 0 && (
              <p className="mt-2 text-xs text-warning">
                This item has no assigned suppliers. Add one on the item before
                ordering against it.
              </p>
            )}
          </div>
        ))}

        <Button size="sm" variant="ghost" onClick={addLine}>
          <Plus size={14} /> Add another item
        </Button>
      </div>
    </div>
  );
}

/** Load the items list once (shared by both dialogs). */
export function useItemsList(open: boolean): {
  items: ApiItem[];
  loading: boolean;
  error: string | null;
} {
  const [items, setItems] = React.useState<ApiItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    itemsApi
      .list(
        { limit: 200, sort: 'item_number', direction: 'asc' },
        { signal: ctrl.signal },
      )
      .then((resp) => setItems(resp.items))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError('Failed to load items.');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [open]);

  return { items, loading, error };
}
