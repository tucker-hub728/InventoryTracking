/**
 * Kitting / back-flush API client — talks to the real backend `/v1/kits`
 * (docs/modules/kitting.md). Mirrors the `tiers.ts` idiom: wire-shape
 * interfaces (snake_case), `evidence_id` + `reason` on the one signed write
 * (close-out). Decimal fields arrive as strings (coerce with `Number()`).
 */
import type { BadgeTone } from '@/types/ui';

import { api } from './client';

export type KitStatus = 'draft' | 'issued' | 'in_production' | 'closed' | 'cancelled';

export const KIT_STATUSES: readonly KitStatus[] = [
  'draft',
  'issued',
  'in_production',
  'closed',
  'cancelled',
];

export const KIT_STATUS_LABEL: Record<KitStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  in_production: 'In Production',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export const KIT_STATUS_TONE: Record<KitStatus, BadgeTone> = {
  draft: 'neutral',
  issued: 'accent',
  in_production: 'warning',
  closed: 'success',
  cancelled: 'danger',
};

/** One occupied cell in an LN2 box — always exactly one unit of one lot. */
export interface CellOption {
  allocation_id: string;
  grid_row: number;
  grid_col: number;
  lot_id: string;
  lot_number: string | null;
  expiration_date: string | null;
}

export interface KitLineSourceOption {
  node_id: string;
  name: string;
  path: string;
  qty: number;
  /** LN2 box: the operator picks cells, and quantity follows the selection. */
  is_grid: boolean;
  grid_rows: number | null;
  grid_cols: number | null;
  cells: CellOption[];
}

/** A free cell to place a returned unit into. */
export interface ReturnCellInput {
  grid_row: number;
  grid_col: number;
}

export interface ApiKitLine {
  id: string;
  line_no: number;
  item_id: string;
  item_number: string;
  description: string;
  /** Decimal (string). */
  qty_per_unit: string;
  /** Decimal (string) = qty_per_unit × target_qty. */
  needed_qty: string;
  issued_qty: number;
  additional_issued_qty: number;
  used_qty: number | null;
  /** Handed back to inventory before close-out (TRX-008). */
  early_returned_qty: number;
  /** issued + additional − early_returned: what is still on the production floor. */
  on_floor_qty: number;
  /** on_floor − used: the close-out back-flush amount (null until used entered). */
  returned_qty: number | null;
  source_location_node_id: string | null;
  return_location_node_id: string | null;
  /** Total available for this component across all locations. */
  on_hand: number;
  /** Locations holding the component, with per-node qty. */
  source_options: KitLineSourceOption[];
  /** Available at the currently-chosen source node (the issue cap). */
  source_available: number;
}

export interface ApiKit {
  id: string;
  kit_number: string;
  item_id: string;
  item_number: string;
  description: string;
  target_qty: number;
  status: KitStatus;
  production_location_node_id: string;
  output_location_node_id: string | null;
  good_qty: number | null;
  scrap_qty: number | null;
  notes: string | null;
  issued_at: string | null;
  closed_at: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  lines: ApiKitLine[];
}

export interface ApiKitListItem {
  id: string;
  kit_number: string;
  item_id: string;
  item_number: string;
  description: string;
  target_qty: number;
  status: KitStatus;
  production_location_node_id: string;
  /** Human path of the production floor (e.g. "Manufacturing Floor"). */
  production_location: string | null;
  /** Human path of where the output was stocked — null until close-out. */
  output_location: string | null;
  good_qty: number | null;
  scrap_qty: number | null;
  line_count: number;
  created_at: string;
}

export interface ApiKitListResponse {
  items: ApiKitListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApiKitActivityRow {
  id: string;
  performed_at: string;
  movement_type: string;
  item_id: string;
  item_number: string;
  qty_delta: number;
  from_location_node_id: string | null;
  to_location_node_id: string | null;
  notes: string | null;
  performed_by_user_id: string;
}

/** One audit-trail event for a kit — carries good/scrap and per-line changes
 *  the stock ledger can't show (scrap never moves stock). Client 2026-07-22. */
export interface ApiKitAuditEvent {
  id: string;
  occurred_at: string;
  /** create | edit_line | issue | additional_issue | early_return |
   *  production_draft | close_out | cancel (falls back to the audit action). */
  operation: string;
  action: string;
  actor_user_id: string | null;
  good_qty: number | null;
  scrap_qty: number | null;
  /** Close-out only: where the produced output was stocked + its lot expiry. */
  output_location: string | null;
  output_expiration_date: string | null;
  diff: Record<string, { before: unknown; after: unknown }> | null;
}

export interface ApiKitActivityResponse {
  items: ApiKitActivityRow[];
  /** Full-snapshot audit events for the kit, newest first. */
  events: ApiKitAuditEvent[];
}

export interface ApiFloorKitLine {
  item_id: string;
  item_number: string;
  description: string;
  on_floor_qty: number;
}

/** An open kit building on a production floor, with its on-floor material. */
export interface ApiFloorKit {
  id: string;
  kit_number: string;
  item_id: string;
  item_number: string;
  description: string;
  target_qty: number;
  status: KitStatus;
  on_floor_total: number;
  lines: ApiFloorKitLine[];
}

export interface ApiFloorKitConsumedLine {
  item_id: string;
  item_number: string;
  description: string;
  used_qty: number;
}

/** A closed kit that built on a floor — what it consumed and yielded. */
export interface ApiFloorKitConsumed {
  id: string;
  kit_number: string;
  item_id: string;
  item_number: string;
  description: string;
  target_qty: number;
  good_qty: number | null;
  scrap_qty: number | null;
  closed_at: string | null;
  consumed_total: number;
  lines: ApiFloorKitConsumedLine[];
}

export interface ApiFloorKitsResponse {
  /** Open kits with material still on the floor. */
  active: ApiFloorKit[];
  /** Recently closed kits that built here — what they consumed. */
  completed: ApiFloorKitConsumed[];
}

export const KIT_OPERATION_LABEL: Record<string, string> = {
  create: 'Kit created',
  edit_line: 'Draft line edited',
  issue: 'Issued to production',
  additional_issue: 'Additional issue',
  early_return: 'Excess returned',
  production_draft: 'Production figures saved',
  close_out: 'Closed out',
  cancel: 'Cancelled',
};

// ── Write inputs ─────────────────────────────────────────────────────────

export interface KitCreateInput {
  /** Operator-supplied kit / batch name. Also names the produced lot. */
  kit_number: string;
  item_id: string;
  target_qty: number;
  production_location_node_id: string;
  notes?: string | null;
}

export interface KitUpdateInput {
  /** New name (editable while the kit is open, not closed/cancelled). */
  kit_number?: string;
  /** New target (editable only while draft — it drives every line's need). */
  target_qty?: number;
}

export interface KitLineUpdateInput {
  issued_qty?: number;
  source_location_node_id?: string;
}

export interface IssueLineInput {
  line_id: string;
  issued_qty: number;
  source_location_node_id?: string | null;
  /** LN2 only: the exact cells to pull. Length must equal issued_qty. */
  cell_allocation_ids?: string[];
}

export interface IssueInput {
  lines: IssueLineInput[];
}

export interface ProductionDraftInput {
  good_qty?: number | null;
  scrap_qty?: number | null;
  output_location_node_id?: string | null;
}

export interface AdditionalIssueInput {
  qty: number;
  /** LN2 only: the exact cells to pull. Length must equal qty. */
  cell_allocation_ids?: string[];
}

/** REQ-2026-07-01-TRX-008 — return excess from the floor, no lot assignment. */
export interface ReturnExcessInput {
  qty: number;
  return_location_node_id: string;
  /** Required when returning into a box: one free cell per unit. */
  return_cells?: ReturnCellInput[];
  reason?: string | null;
}

export interface CloseOutLineInput {
  line_id: string;
  used_qty: number;
  return_location_node_id?: string | null;
  return_cells?: ReturnCellInput[];
}

export interface CloseOutInput {
  good_qty: number;
  scrap_qty: number;
  output_location_node_id: string;
  /** Expiry of the produced lot (REQ-2026-07-01-INV-008). ISO yyyy-mm-dd. */
  output_expiration_date?: string | null;
  lines: CloseOutLineInput[];
  /** Signed write. */
  evidence_id: string;
  reason: string;
}

export interface CancelLineInput {
  line_id: string;
  return_location_node_id: string;
  return_cells?: ReturnCellInput[];
}

export interface CancelInput {
  /** Signed write — cancelling is electronically signed. */
  evidence_id: string;
  reason?: string;
  /** Per-line return destinations. Must cover every line still on the floor. */
  lines?: CancelLineInput[];
}

export const MOVEMENT_TYPE_LABEL: Record<string, string> = {
  kit_issue: 'Kit issue',
  kit_additional_issue: 'Additional issue',
  production_output: 'Production output',
  // Three distinct return events (kitting05): the signed close-out
  // reconciliation, an operator handing excess back mid-production, and a
  // cancelled kit giving everything back.
  backflush: 'Back-flushed',
  kit_return: 'Returned',
  kit_cancel_return: 'Cancel return',
  receipt: 'Unit in',
  dispense: 'Unit out',
  adjustment: 'Adjustment',
  discard: 'Discard',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
};

export const kitsApi = {
  list: (
    params: { status?: KitStatus; limit?: number; offset?: number } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<ApiKitListResponse>('/kits', {
      query: {
        status: params.status ?? undefined,
        limit: params.limit ?? undefined,
        offset: params.offset ?? undefined,
      },
      signal: opts?.signal,
    }),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiKit>(`/kits/${id}`, { signal: opts?.signal }),

  activity: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiKitActivityResponse>(`/kits/${id}/activity`, { signal: opts?.signal }),

  /** Open kits building on a production floor + their on-floor material. */
  onFloor: (nodeId: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiFloorKitsResponse>(`/kits/floor/${nodeId}`, { signal: opts?.signal }),

  /** A free KIT-#### to pre-fill the name field. Peeks, never consumes. */
  nextNumber: (opts?: { signal?: AbortSignal }) =>
    api.get<{ kit_number: string }>('/kits/next-number', { signal: opts?.signal }),

  create: (input: KitCreateInput) => api.post<ApiKit>('/kits', { json: input }),

  update: (id: string, input: KitUpdateInput) => api.patch<ApiKit>(`/kits/${id}`, { json: input }),

  updateLine: (id: string, lineId: string, input: KitLineUpdateInput) =>
    api.patch<ApiKit>(`/kits/${id}/lines/${lineId}`, { json: input }),

  issue: (id: string, input?: IssueInput) =>
    api.post<ApiKit>(`/kits/${id}/issue`, input ? { json: input } : {}),

  saveProduction: (id: string, input: ProductionDraftInput) =>
    api.patch<ApiKit>(`/kits/${id}/production`, { json: input }),

  additionalIssue: (id: string, lineId: string, input: AdditionalIssueInput) =>
    api.post<ApiKit>(`/kits/${id}/lines/${lineId}/additional-issue`, { json: input }),

  returnExcess: (id: string, lineId: string, input: ReturnExcessInput) =>
    api.post<ApiKit>(`/kits/${id}/lines/${lineId}/return`, { json: input }),

  closeOut: (id: string, input: CloseOutInput) =>
    api.post<ApiKit>(`/kits/${id}/close-out`, { json: input }),

  cancel: (id: string, input: CancelInput) =>
    api.post<ApiKit>(`/kits/${id}/cancel`, { json: input }),
};

/** Derived helpers (the backend derives needed/returned already, but the list
 *  view and forms need a couple of client-side computations). */
export function kitYield(good: number | null, scrap: number | null): number | null {
  if (good === null || scrap === null) return null;
  const total = good + scrap;
  return total === 0 ? null : good / total;
}
