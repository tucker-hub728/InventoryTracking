/**
 * BOM API surface — wraps ``/api/v1/items/{id}/bom``, ``/bom-lines/{id}`` and
 * ``/items/{id}/where-used``.
 *
 * A BOM line links a parent (built) item to a child item × qty per run; the
 * child may itself be built, giving multi-level / nested BOMs. Add / update /
 * delete are electronically signed (``evidence_id`` + ``reason``).
 */

import { api } from './client';

import type { CategoryKind } from './categories';

export interface ApiBomLine {
  id: string;
  parent_item_id: string;
  child_item_id: string;
  child_item_number: string;
  child_description: string;
  child_category_name: string;
  child_category_kind: CategoryKind;
  child_category_tone: string;
  qty_per_run: string;
  child_qty_on_hand: string;
  /** The child's real available stock (on-hand minus expired) — the "Available"
   *  column, same number as the inventory list. */
  child_qty_available: string;
  /** The child's real stock status (matches the inventory list badge). */
  child_status_code: 'available' | 'low_stock' | 'out_of_stock';
  /** True when the child itself has a BOM (so the UI can expand it). */
  child_has_bom: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiItemBom {
  item_id: string;
  lines: ApiBomLine[];
}

export interface ApiWhereUsed {
  parent_item_id: string;
  parent_item_number: string;
  parent_description: string;
  parent_category_name: string;
  qty_per_run: string;
}

export interface BomLineCreateInput {
  child_item_id: string;
  qty_per_run: number;
  evidence_id: string;
  reason: string;
}

export interface BomLineUpdateInput {
  qty_per_run: number;
  evidence_id: string;
  reason: string;
}

export interface BomLineDeleteInput {
  evidence_id: string;
  reason: string;
}

export const bomApi = {
  /** An item's direct BOM lines + its one-level buildable count. */
  forItem: (itemId: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiItemBom>(`/items/${itemId}/bom`, { signal: opts?.signal }),

  addLine: (itemId: string, input: BomLineCreateInput) =>
    api.post<ApiBomLine>(`/items/${itemId}/bom`, { json: input }),

  updateLine: (lineId: string, input: BomLineUpdateInput) =>
    api.patch<ApiBomLine>(`/bom-lines/${lineId}`, { json: input }),

  removeLine: (lineId: string, input: BomLineDeleteInput) =>
    api.delete<ApiBomLine>(`/bom-lines/${lineId}`, { json: input }),

  /** Items whose BOM consumes this item (where-used / inverse BOM). */
  whereUsed: (itemId: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiWhereUsed[]>(`/items/${itemId}/where-used`, {
      signal: opts?.signal,
    }),
};
