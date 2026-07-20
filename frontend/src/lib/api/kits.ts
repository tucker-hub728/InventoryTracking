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

export interface KitLineSourceOption {
  node_id: string;
  name: string;
  path: string;
  qty: number;
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

export interface ApiKitActivityResponse {
  items: ApiKitActivityRow[];
}

// ── Write inputs ─────────────────────────────────────────────────────────

export interface KitCreateInput {
  item_id: string;
  target_qty: number;
  production_location_node_id: string;
  notes?: string | null;
}

export interface KitLineUpdateInput {
  issued_qty?: number;
  source_location_node_id?: string;
}

export interface IssueLineInput {
  line_id: string;
  issued_qty: number;
  source_location_node_id?: string | null;
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
}

export interface CloseOutLineInput {
  line_id: string;
  used_qty: number;
  return_location_node_id?: string | null;
}

export interface CloseOutInput {
  good_qty: number;
  scrap_qty: number;
  output_location_node_id: string;
  lines: CloseOutLineInput[];
  /** Signed write. */
  evidence_id: string;
  reason: string;
}

export interface CancelInput {
  reason?: string | null;
}

export const MOVEMENT_TYPE_LABEL: Record<string, string> = {
  kit_issue: 'Kit issue',
  kit_additional_issue: 'Additional issue',
  production_output: 'Production output',
  backflush: 'Backflushed',
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

  create: (input: KitCreateInput) => api.post<ApiKit>('/kits', { json: input }),

  updateLine: (id: string, lineId: string, input: KitLineUpdateInput) =>
    api.patch<ApiKit>(`/kits/${id}/lines/${lineId}`, { json: input }),

  issue: (id: string, input?: IssueInput) =>
    api.post<ApiKit>(`/kits/${id}/issue`, input ? { json: input } : {}),

  saveProduction: (id: string, input: ProductionDraftInput) =>
    api.patch<ApiKit>(`/kits/${id}/production`, { json: input }),

  additionalIssue: (id: string, lineId: string, input: AdditionalIssueInput) =>
    api.post<ApiKit>(`/kits/${id}/lines/${lineId}/additional-issue`, { json: input }),

  closeOut: (id: string, input: CloseOutInput) =>
    api.post<ApiKit>(`/kits/${id}/close-out`, { json: input }),

  cancel: (id: string, input: CancelInput = {}) =>
    api.post<ApiKit>(`/kits/${id}/cancel`, { json: input }),
};

/** Derived helpers (the backend derives needed/returned already, but the list
 *  view and forms need a couple of client-side computations). */
export function kitYield(good: number | null, scrap: number | null): number | null {
  if (good === null || scrap === null) return null;
  const total = good + scrap;
  return total === 0 ? null : good / total;
}
