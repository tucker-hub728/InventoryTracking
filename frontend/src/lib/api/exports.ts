/**
 * ``/v1/exports`` — file exports of current state.
 *
 * RPT-001. Two shapes of the same data:
 *
 * * ``inventoryXlsx`` — the tabbed workbook the UI ships: a summary tab
 *   matching the screen, then one tab per item that has stock, an arrival or
 *   an open order.
 * * ``inventoryCsv`` — the flat, full-column CSV the requirement specifies.
 *   No button today; kept because it is the exact-decimal artefact to
 *   reconcile against, and because RPT-001 asks for a CSV in so many words.
 *
 * Both are downloads, so this client does no parsing or formatting — it moves
 * bytes to disk and lets finance do their own arithmetic.
 */

import { api, type DownloadResult } from './client';

/** Which kinds of row to include in the CSV. Omit for all four. */
export type ExportRowKind =
  | 'on_hand'
  | 'awaiting_release'
  | 'on_order'
  | 'item_valuation';

export interface InventoryExportParams {
  /** Limit to one tier. The per-tier pages pass their own, so the file matches
   *  the screen the user pressed the button on. */
  tierId?: string;
  prefixId?: string;
  supplierId?: string;
  /** Same search text the list is filtered by. */
  q?: string;
  isConsumable?: boolean;
}

export interface InventoryXlsxParams extends InventoryExportParams {
  /** Name for the summary tab — the tier title, e.g. "Raw Materials". */
  title?: string;
}

export interface InventoryCsvParams extends InventoryExportParams {
  rowKinds?: readonly ExportRowKind[];
}

function baseQuery(params: InventoryExportParams) {
  return {
    tier_id: params.tierId,
    prefix_id: params.prefixId,
    supplier_id: params.supplierId,
    q: params.q,
    is_consumable: params.isConsumable,
  };
}

export const exportsApi = {
  /** The tabbed Excel workbook. What the Export button downloads. */
  inventoryXlsx: (
    params: InventoryXlsxParams = {},
    opts?: { signal?: AbortSignal },
  ): Promise<DownloadResult> =>
    api.download('/exports/inventory.xlsx', {
      query: { ...baseQuery(params), title: params.title },
      signal: opts?.signal,
    }),

  /** The flat full-column CSV (RPT-001 as written). No UI button today. */
  inventoryCsv: (
    params: InventoryCsvParams = {},
    opts?: { signal?: AbortSignal },
  ): Promise<DownloadResult> =>
    api.download('/exports/inventory.csv', {
      query: { ...baseQuery(params), row_kinds: params.rowKinds },
      signal: opts?.signal,
    }),
};
