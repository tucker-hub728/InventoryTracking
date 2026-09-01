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

/** Row kinds in the kit-cost dump (RPT-003). Omit for all six. */
export type KitCostRowKind =
  | 'material_issue'
  | 'material_return'
  | 'batch_consumption'
  | 'batch_output'
  | 'output_shipment'
  | 'kit_summary';

/** How much of the story to include — the choice the export dialog offers.
 *
 *  Row kinds are the API's vocabulary, not a reader's. These three are what a
 *  non-technical person actually wants to pick between, and each maps to a
 *  subset below. */
export type KitCostDetail = 'summary' | 'costs' | 'full';

/** Detail level → row kinds. Named here rather than in the component so the
 *  meaning of "Summary" lives with the API wrapper it parameterises. */
export const KIT_COST_DETAIL_KINDS: Record<KitCostDetail, readonly KitCostRowKind[]> = {
  /** One line per finished lot, plus a total per kit. What you send finance. */
  summary: ['batch_output', 'kit_summary'],
  /** Adds what each component contributed and where the lots went. */
  costs: ['batch_output', 'kit_summary', 'batch_consumption', 'output_shipment'],
  /** Everything, including every issue and return movement. */
  full: [
    'material_issue',
    'material_return',
    'batch_consumption',
    'batch_output',
    'output_shipment',
    'kit_summary',
  ],
};

export interface KitCostExportParams {
  /** ISO datetime, INCLUSIVE. */
  occurredFrom?: string;
  /** ISO datetime, EXCLUSIVE — the range is half-open, matching the audit
   *  filters. To include a whole day, send the start of the NEXT day. */
  occurredTo?: string;
  kitId?: string;
  status?: string;
  rowKinds?: readonly KitCostRowKind[];
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

  /** The kit material cost dump (RPT-003). Admin + Super Admin only — it
   *  carries what each customer is charged per finished lot. */
  kitCostsCsv: (
    params: KitCostExportParams = {},
    opts?: { signal?: AbortSignal },
  ): Promise<DownloadResult> =>
    api.download('/exports/kit-costs.csv', {
      query: {
        occurred_from: params.occurredFrom,
        occurred_to: params.occurredTo,
        kit_id: params.kitId,
        status: params.status,
        row_kinds: params.rowKinds,
      },
      signal: opts?.signal,
    }),
};
