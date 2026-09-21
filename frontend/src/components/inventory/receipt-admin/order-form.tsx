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
import { priceInputValue } from '@/lib/utils';

// ── Draft model ────────────────────────────────────────────────────────────

export interface OrderLineDraft {
  key: string;
  item_id: string;
  supplierChoice: string; // supplier id | ''
  /** In ORDER units — "3" means three boxes when pack_uom is set (REQ-001). */
  ordered_qty: string;
  /** Per ORDER unit — the price of one box, matching the supplier invoice. */
  unit_price: string;
  // ── Tiered unit of measure (REQ-001) ──────────────────────────────
  // Typed per line — a pack belongs to the purchase, not to the item, so there
  // is nothing to inherit. Empty pack_uom = ordered in the item's consume
  // unit, which is how every line behaved before REQ-001.
  pack_uom: string;
  units_per_pack: string;
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

/** Mirrors MAX_QTY in backend/app/core/bounds.py. Checked here against the
 *  PRODUCT (packs × pack size), because each half can be individually legal
 *  while the units that would land in a location are not. */
const MAX_LINE_UNITS = 1_000_000;

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
    pack_uom: '',
    units_per_pack: '',
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
      unit_price: priceInputValue(l.unit_price_amount),
      // The line's OWN frozen pack, not the item's current one — editing an
      // order must not silently re-price it at a pack size nobody agreed to.
      pack_uom: l.pack_uom ?? '',
      units_per_pack: l.units_per_pack == null ? '' : String(l.units_per_pack),
      // Seed with the line's own supplier so the Select shows a label before the
      // item's full supplier list resolves; the loader replaces it.
      //
      // ``is_active: true`` is a stand-in for an ALREADY-COMMITTED choice, not a
      // claim about the supplier's current state. The active-only filter on the
      // Select would otherwise drop it and leave an existing order line looking
      // supplier-less — a supplier deactivated after the order was placed must
      // still show on that order.
      suppliers: [
        { supplier_id: l.supplier_id, supplier_name: l.supplier_name ?? '', is_active: true },
      ],
      suppliersLoading: false,
    })),
  };
}

/** "3 Box × 100 = 300 Each · $0.95 each" — the conversion in words, under the
 *  line it describes (REQ-001).
 *
 *  Returns null unless there is a complete pack AND a quantity, because with
 *  either missing the sentence would restate the inputs rather than add to
 *  them. The per-unit price is appended only when a price is present; it is the
 *  figure inventory is actually valued at, and seeing it here is what catches a
 *  price typed per-Each into a per-Box field.
 */
function lineUnitsSummary(line: OrderLineDraft): string | null {
  const packUom = line.pack_uom.trim();
  const size = Number(line.units_per_pack);
  const qty = Number(line.ordered_qty);
  if (!packUom || !Number.isInteger(size) || size <= 0) return null;
  if (!Number.isInteger(qty) || qty <= 0) return null;

  const total = qty * size;
  if (total > MAX_LINE_UNITS) return null; // the validator will say why

  let out = `${qty} ${packUom} × ${size} = ${total.toLocaleString()} units`;
  const price = Number(line.unit_price);
  if (line.unit_price.trim() !== '' && Number.isFinite(price) && price >= 0) {
    // Six decimals matches what the lot stores; trailing zeros trimmed so the
    // common exact case reads "$0.95" rather than "$0.950000".
    const per = (price / size).toFixed(6).replace(/\.?0+$/, '');
    out += ` · $${per} per unit`;
  }
  return out;
}

/** What this line commits to spending: quantity × price, both in ORDER units.
 *  Null when either is missing — a blank price is "not agreed yet", which is
 *  a different thing from zero and must not be totalled as if it were. */
function lineTotal(line: OrderLineDraft): number | null {
  const qty = Number(line.ordered_qty);
  const price = Number(line.unit_price);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (line.unit_price.trim() === '' || !Number.isFinite(price) || price < 0) return null;
  return qty * price;
}

/** Consume units this line will eventually place — the physical size of the
 *  order, which is not the same question as what it costs. */
function lineUnits(line: OrderLineDraft): number | null {
  const qty = Number(line.ordered_qty);
  if (!Number.isInteger(qty) || qty <= 0) return null;
  const size = Number(line.units_per_pack);
  if (!line.pack_uom.trim()) return qty;
  if (!Number.isInteger(size) || size <= 0) return null;
  return qty * size;
}

/**
 * The order as a commitment, not as a set of fields.
 *
 * A PO is a financial document, and the form had no figure anywhere for what
 * signing it would cost — two lines at $45 and $175 sat side by side with the
 * $220 left as an exercise. ``pricedLines`` is tracked separately so a partial
 * total can say so: silently reporting $45 for an order whose second line has
 * no agreed price yet would be worse than reporting nothing.
 */
function orderTotals(lines: OrderLineDraft[]) {
  let cost = 0;
  let units = 0;
  let pricedLines = 0;
  let unitsKnown = true;
  for (const l of lines) {
    if (!l.item_id) continue;
    const t = lineTotal(l);
    if (t != null) {
      cost += t;
      pricedLines += 1;
    }
    const u = lineUnits(l);
    if (u == null) unitsKnown = false;
    else units += u;
  }
  const filled = lines.filter((l) => l.item_id).length;
  return { cost, units, pricedLines, filled, unitsKnown };
}

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

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
    if (!Number.isInteger(qty)) {
      // Whole packs only — you cannot order half a box, and a fractional
      // ordered_qty would make outstanding un-subtractable against receipts.
      return { error: `Line ${n}: ordered qty must be a whole number.` };
    }
    let unitPrice: number | undefined;
    if (l.unit_price.trim() !== '') {
      const p = Number(l.unit_price);
      if (!Number.isFinite(p) || p < 0) {
        return { error: `Line ${n}: unit price must be a non-negative number.` };
      }
      unitPrice = p;
    }

    // ── Tiered unit of measure (REQ-001) ──────────────────────────────
    const packUom = l.pack_uom.trim();
    const packSizeRaw = l.units_per_pack.trim();
    let packSize: number | undefined;
    if (packSizeRaw !== '') {
      if (!packUom) {
        // Mirrors the server rule: a factor with no unit would silently
        // multiply a line ordered in consume units.
        return {
          error: `Line ${n}: enter an order unit (e.g. Box) before the units per unit.`,
        };
      }
      const s = Number(packSizeRaw);
      if (!Number.isInteger(s) || s <= 0) {
        return { error: `Line ${n}: units per ${packUom} must be a whole number above 0.` };
      }
      packSize = s;
      if (qty * s > MAX_LINE_UNITS) {
        return {
          error:
            `Line ${n}: ${qty} × ${s} is ${(qty * s).toLocaleString()} units, ` +
            `above the ${MAX_LINE_UNITS.toLocaleString()} limit.`,
        };
      }
    }

    lines.push({
      item_id: l.item_id,
      supplier_id: l.supplierChoice,
      ordered_qty: qty,
      unit_price: unitPrice,
      // Send null rather than omitting, so clearing an order unit on an edit
      // actually clears it instead of falling back to the item's default.
      pack_uom: packUom || null,
      units_per_pack: packSize ?? null,
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
  // The pack is cleared with it: there is no item-level default to pre-fill
  // from (REQ-001), and carrying the previous item's "Box / 100" over to a new
  // item would be worse than an empty field — it books a hundredth of the
  // units that actually arrive, and looks entirely ordinary doing it.
  const onItemChange = React.useCallback(
    (key: string, itemId: string) => {
      patchLine(key, {
        item_id: itemId,
        supplierChoice: '',
        pack_uom: '',
        units_per_pack: '',
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
  // Only purchased items are orderable — built/product items are BOM outputs
  // with no supplier to receive against (no unit-in / unit-out flow).
  const itemOptions = React.useMemo<SearchableSelectOption[]>(
    () =>
      items
        .filter((i) => i.tier_type === 'raw_material')
        .map((i) => ({
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
      {/* Order # is full-width while the blanket-order option is hidden. To
          re-enable the blanket order, wrap this field and the commented block
          below back in a `grid grid-cols-2 gap-3` container. */}
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

      {/* Blanket order — hidden for now (kept for later use).
      <div className="flex items-end pb-1.5">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-text-2">
          <input
            type="checkbox"
            className="size-4 cursor-pointer rounded border-border-strong accent-accent"
            checked={state.is_blanket}
            onChange={(e) =>
              setState((prev) => ({ ...prev, is_blanket: e.target.checked }))
            }
          />
          Blanket order
        </label>
      </div>
      */}

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
            {/* The header names the line and prices it. "Item 1" was pure
                chrome — the picker below already says which item this is — and
                the one thing a buyer wants per line, what it costs, was
                nowhere on the form. */}
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-medium text-text-2">
                {(() => {
                  const picked = items.find((i) => i.id === line.item_id);
                  if (!picked) return `Item ${idx + 1}`;
                  return (
                    <>
                      <span className="font-mono text-accent">
                        {picked.item_number}
                      </span>
                      <span className="ml-2 font-normal text-text-3">
                        {picked.description}
                      </span>
                    </>
                  );
                })()}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {lineTotal(line) != null && (
                  <span className="tabular-nums text-xs font-medium text-text-1">
                    {MONEY.format(lineTotal(line)!)}
                  </span>
                )}
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
              </span>
            </div>

            <div className="space-y-1.5">
              <Label>
                Item <span className="text-danger">*</span>
              </Label>
              <SearchableSelect
                aria-label="Item"
                modal
                options={itemOptions}
                value={line.item_id}
                onChange={(v) => onItemChange(line.key, v)}
                disabled={itemsLoading || items.length === 0}
                placeholder={itemsLoading ? 'Loading…' : 'Select item'}
                searchPlaceholder="Search by item number or description…"
                emptyText="No matching items."
              />
            </div>

            {/* Supplier gets its own row. Sharing a five-up grid with the four
                numeric fields left it ~110px wide, which rendered "Applied
                Cells Inc." as "Applied …" — a picker whose selected value you
                cannot read is not a picker. The numbers that follow are short
                and genuinely do fit four across. */}
            <div className="mt-3 space-y-1.5">
              <div className="space-y-1.5">
                <Label>
                  Supplier <span className="text-danger">*</span>
                </Label>
                <SearchableSelect
                  aria-label="Supplier"
                  modal
                  // Active only. Deactivating a supplier promises it is hidden
                  // from new item / lot pickers, and an order line creates a
                  // lot at receive — so a deactivated supplier must not be
                  // orderable even while the item is still assigned to it.
                  //
                  // The assignment itself is untouched, and an order ALREADY
                  // placed against a since-deactivated supplier still receives
                  // normally: the receive-side check reads the item's whole
                  // assigned set, not this filtered one.
                  options={line.suppliers
                    .filter((v) => v.is_active)
                    .map((v) => ({
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
                        : line.suppliers.some((v) => v.is_active)
                          ? 'Select supplier'
                          : line.suppliers.length > 0
                            ? 'All suppliers deactivated'
                            : 'Item has no suppliers'
                  }
                  searchPlaceholder="Search suppliers…"
                  emptyText="No matching suppliers."
                />
              </div>
            </div>

            {/* Two across on a phone, four from sm. These read left to right as
                the sentence the summary line below restates: 3 box × 100 at
                $15.00 each. */}
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
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
                <Label>Order unit</Label>
                <Input
                  placeholder="Each"
                  value={line.pack_uom}
                  onChange={(e) =>
                    patchLine(line.key, { pack_uom: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>
                  {line.pack_uom.trim()
                    ? `Units per ${line.pack_uom.trim()}`
                    : 'Units per unit'}
                </Label>
                <Input
                  type="number"
                  min={1}
                  step="1"
                  placeholder={line.pack_uom.trim() ? '100' : '—'}
                  value={line.units_per_pack}
                  // Only meaningful once there is a unit to be a count OF.
                  disabled={!line.pack_uom.trim()}
                  onChange={(e) =>
                    patchLine(line.key, { units_per_pack: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>
                  {line.pack_uom.trim()
                    ? `Unit price per ${line.pack_uom.trim()}`
                    : 'Unit price'}
                </Label>
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

            {/* The whole point of the feature, stated in the operator's own
                terms. Shown only when it says something the inputs do not. */}
            {lineUnitsSummary(line) && (
              <p className="mt-2 text-xs text-text-3">{lineUnitsSummary(line)}</p>
            )}

            {/* Two different dead ends, two different fixes — saying "no
                suppliers" when the item HAS them but they are all deactivated
                sends someone off to re-add a supplier that is already there. */}
            {line.item_id &&
              !line.suppliersLoading &&
              !line.suppliers.some((v) => v.is_active) && (
                <p className="mt-2 text-xs text-warning">
                  {line.suppliers.length > 0
                    ? `Every supplier assigned to this item is deactivated (${line.suppliers
                        .map((v) => v.supplier_name)
                        .join(', ')}). Reactivate one, or assign another on the item.`
                    : 'This item has no assigned suppliers. Add one on the item before ordering against it.'}
                </p>
              )}
          </div>
        ))}

        <Button size="sm" variant="ghost" onClick={addLine}>
          <Plus size={14} /> Add another item
        </Button>

        <OrderTotals lines={state.lines} />
      </div>
    </div>
  );
}

/**
 * What signing this actually commits to.
 *
 * Nothing on this form used to add up. A buyer raising a two-line PO for
 * $45.00 and $175.00 had to total it in their head, on the screen where the
 * commitment is made — and the physical size of the order, which decides
 * whether there is anywhere to put it, was equally absent.
 *
 * It stays quiet until there is something true to say: no lines, no panel. A
 * partial total announces itself as partial rather than under-reporting, since
 * a confident "$45.00" on an order that is really $220 is worse than no figure
 * at all.
 */
function OrderTotals({ lines }: { lines: OrderLineDraft[] }) {
  const { cost, units, pricedLines, filled, unitsKnown } = orderTotals(lines);
  if (filled === 0) return null;

  const partial = pricedLines > 0 && pricedLines < filled;

  return (
    <div className="mt-1 rounded-md border border-border bg-surface-2 px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs text-text-3">
          {filled} {filled === 1 ? 'item' : 'items'}
          {unitsKnown && units > 0 && (
            <>
              {' · '}
              <span className="tabular-nums">{units.toLocaleString()}</span> units
            </>
          )}
        </span>
        {pricedLines === 0 ? (
          <span className="text-xs text-text-3">No prices entered</span>
        ) : (
          <span className="text-right">
            <span className="text-xs text-text-3">Order total </span>
            <span className="tabular-nums text-sm font-semibold text-text-1">
              {MONEY.format(cost)}
            </span>
          </span>
        )}
      </div>
      {partial && (
        <p className="mt-1 text-xs text-warning">
          {filled - pricedLines} of {filled} lines have no price — the total
          covers {pricedLines} {pricedLines === 1 ? 'line' : 'lines'}.
        </p>
      )}
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
    // ``listAll``, not ``list({ limit: 200 })``: the picker searches client-side,
    // so item 201 onwards was unfindable ("No matching items").
    itemsApi
      .listAll({ sort: 'item_number', direction: 'asc' }, { signal: ctrl.signal })
      .then(setItems)
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError('Failed to load items.');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [open]);

  return { items, loading, error };
}
