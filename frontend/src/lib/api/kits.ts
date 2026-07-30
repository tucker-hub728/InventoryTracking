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

/** One lot of a component available at one location — a pickable issue source
 *  (KIT-002/003). Listed FIFO-ordered so the picker can split a need across
 *  lots. For a box, `cells` are the exact vials of this lot. */
export interface KitLineSourceLot {
  lot_id: string;
  lot_number: string | null;
  expiration_date: string | null;
  node_id: string;
  node_name: string;
  path: string;
  qty: number;
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
  /** Locations holding the component, with per-node qty (legacy picker). */
  source_options: KitLineSourceOption[];
  /** Per-lot sources for the multi-source picker (KIT-002/003), FIFO-ordered. */
  source_lots: KitLineSourceLot[];
  /** The (lot, location) this line was ISSUED from — the post-issue snapshot. */
  issued_from: KitLineIssuedFrom[];
  /** Per-lot WIP on the production floor — pickable RETURN sources (the operator
   *  picks which floor lot's units to hand back). FIFO-ordered by expiry. */
  on_floor_lots: KitLineFloorLot[];
  /** Available at the currently-chosen source node (the issue cap). */
  source_available: number;
}

/** One lot of a component on the production floor — a pickable return source. */
export interface KitLineFloorLot {
  lot_id: string;
  lot_number: string | null;
  qty: number;
}

/** One (lot, source location) a line was issued from, with the quantity. */
export interface KitLineIssuedFrom {
  lot_number: string | null;
  location: string;
  qty: number;
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
  /** Material this batch consumed, per component (produce & close). Consuming
   *  writes no stock movement, so this is the only record of a produce batch's
   *  consumption. Empty for non-producing events. */
  consumed: KitConsumedLine[];
  diff: Record<string, { before: unknown; after: unknown }> | null;
}

/** One component consumed by a produce / close batch. */
export interface KitConsumedLine {
  item_id: string;
  item_number: string;
  qty: number;
}

export interface ApiKitActivityResponse {
  items: ApiKitActivityRow[];
  /** Full-snapshot audit events for the kit, newest first. */
  events: ApiKitAuditEvent[];
}

/** A kit audit event surfaced on an ITEM's audit history (AUD-001) — the kit
 *  event shape plus which kit it belongs to and its e-signature. */
export interface ApiItemKitAuditEvent extends ApiKitAuditEvent {
  kit_id: string;
  kit_number: string | null;
  signature_id: string | null;
}

export interface ApiItemKitAuditResponse {
  /** Kit audit events for every kit this item took part in, newest first. */
  events: ApiItemKitAuditEvent[];
}

export interface ApiFloorKitLine {
  item_id: string;
  item_number: string;
  description: string;
  on_floor_qty: number;
}

export interface ApiFloorKitConsumedLine {
  item_id: string;
  item_number: string;
  description: string;
  used_qty: number;
}

/** One batch a kit has already produced while still open (KIT-007) — its lot. */
export interface ApiFloorKitBatch {
  lot_number: string | null;
  qty: number;
  produced_at: string | null;
}

/** An open kit building on a production floor, with its on-floor material and
 *  what it has already produced/consumed (incremental production, KIT-007). */
export interface ApiFloorKit {
  id: string;
  kit_number: string;
  item_id: string;
  item_number: string;
  description: string;
  target_qty: number;
  status: KitStatus;
  on_floor_total: number;
  good_qty: number;
  scrap_qty: number;
  consumed_total: number;
  lines: ApiFloorKitLine[];
  /** Batches produced so far (each a minted lot) and the material they consumed. */
  batches: ApiFloorKitBatch[];
  consumed: ApiFloorKitConsumedLine[];
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

/** A kit CANCELLED after it had already produced on this floor. The cancel
 *  doesn't undo those batches — the units are real stock on real lots — so the
 *  floor still accounts for them (client 2026-07-28). */
export interface ApiFloorKitCancelled {
  id: string;
  kit_number: string;
  item_id: string;
  item_number: string;
  description: string;
  target_qty: number;
  good_qty: number | null;
  scrap_qty: number | null;
  cancelled_at: string | null;
  consumed_total: number;
  batches: ApiFloorKitBatch[];
  lines: ApiFloorKitConsumedLine[];
}

/**
 * What ONE kit did with one item — issued, used, handed back.
 *
 * Consumption writes no stock movement (the material left `v_item_stock` at
 * issue, kitting.md §4.3), so the ledger can show `Kitted` and `Back-flushed`
 * but never the *used* figure between them. This supplies it, so the ledger can
 * read the way REQ-2026-07-09-TRX-003 describes: "issued fifteen, used twelve,
 * backflushed three".
 *
 * `remainder` = issued_total − early_returned_qty − used_qty. On a **closed**
 * kit that's what was back-flushed at close-out; on an **open** one it's what is
 * still on the production floor.
 */
export interface ApiItemKitConsumption {
  kit_id: string;
  kit_number: string;
  status: KitStatus;
  issued_total: number;
  used_qty: number;
  early_returned_qty: number;
  remainder: number;
}

/** The three tabs of a production floor's page, named for the kit STATUS each
 *  holds — `closed` is what the rest of the app calls that state (see
 *  KIT_STATUS_LABEL), so the tab and the badge inside it agree. */
export type FloorSection = 'in_production' | 'closed' | 'cancelled';

export interface ApiFloorKitCounts {
  in_production: number;
  closed: number;
  cancelled: number;
}

/** One PAGE of one section, plus the counts for every tab. Only the array
 *  matching `section` is populated — the floor page fetches the tab being
 *  viewed rather than all three. */
export interface ApiFloorKitsResponse {
  section: FloorSection;
  /** Rows in the requested section across all pages (drives the pager). */
  total: number;
  counts: ApiFloorKitCounts;
  /** Open kits with material still on the floor. */
  active: ApiFloorKit[];
  /** Closed kits that built here — what they consumed. */
  completed: ApiFloorKitConsumed[];
  /** Cancelled kits that had already produced here before being abandoned. */
  cancelled: ApiFloorKitCancelled[];
}

export const KIT_OPERATION_LABEL: Record<string, string> = {
  create: 'Kit created',
  edit_line: 'Draft line edited',
  issue: 'Issued to production',
  additional_issue: 'Additional issue',
  early_return: 'Excess returned',
  production_draft: 'Production figures saved',
  produce: 'Produced a batch',
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

/** One lot pick within a line's issue — draw `qty` of the component from a
 *  specific (location, lot). For a box lot, `cell_allocation_ids` names the
 *  exact vials and `qty` follows their count (KIT-003). */
export interface IssueSourceInput {
  node_id: string;
  lot_id?: string | null;
  qty: number;
  cell_allocation_ids?: string[];
}

export interface IssueLineInput {
  line_id: string;
  /** Multi-source (preferred): draw the need across one or more lot picks. */
  sources?: IssueSourceInput[];
  /** Legacy single-source (used only when `sources` is empty). */
  issued_qty?: number;
  source_location_node_id?: string | null;
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
  /** Multi-source (preferred, KIT-004): pull the extra from any lots/shelves. */
  sources?: IssueSourceInput[];
  /** Legacy single-source (used only when `sources` is empty). */
  qty?: number;
  cell_allocation_ids?: string[];
}

/** One (floor lot → storage) return pick — hand back qty of a specific on-floor
 *  lot to a location. The unit keeps its origin lot (TRX-008: never stranded). */
export interface ReturnSourceInput {
  lot_id: string;
  qty: number;
  return_location_node_id: string;
  /** Required when the return target is a box: one free cell per returned unit. */
  return_cells?: ReturnCellInput[];
}

/** REQ-2026-07-01-TRX-008 — return excess from the floor. Prefers `sources` (the
 *  operator picks which on-floor lot to return and where); the legacy single
 *  `qty` + `return_location_node_id` (FIFO across lots) is used when omitted. */
export interface ReturnExcessInput {
  sources?: ReturnSourceInput[];
  qty?: number;
  return_location_node_id?: string;
  /** Required when returning into a box: one free cell per unit (legacy path). */
  return_cells?: ReturnCellInput[];
  reason?: string | null;
}

/** Per-component close-out: material used + where the leftover back-flushes. */
export interface CloseOutLineInput {
  line_id: string;
  used_qty: number;
  /** Wins when present; must total the line's leftover. Split the back-flush
   *  across boxes when no single one has enough free cells. */
  destinations?: ReturnDestinationInput[];
  return_location_node_id?: string | null;
  return_cells?: ReturnCellInput[];
}

/** One component's material consumed by a produce batch (operator-entered). */
export interface ProduceLineInput {
  line_id: string;
  used_qty: number;
}

/** One place a produced batch is stocked. Split a batch across several when a
 *  single box can't hold every unit (client 2026-07-23) — the units stay ONE lot
 *  placed across the destinations, and the `qty`s must sum to `good_qty`. A box
 *  destination lists one `cells` entry per unit; a shelf/freezer takes `qty`. */
export interface OutputDestinationInput {
  location_node_id: string;
  qty: number;
  cells?: ReturnCellInput[];
}

/** Produce a batch and KEEP the kit open (KIT-007 incremental production).
 *  The operator enters `used` per component (≥ recipe need, ≤ on-floor). */
export interface ProduceInput {
  good_qty: number;
  scrap_qty: number;
  /** Multi-destination output (split across locations). */
  outputs: OutputDestinationInput[];
  output_expiration_date?: string | null;
  /** Operator-entered lot number for the produced batch (client 2026-07-24 —
   *  replaces the old auto KIT-0289-N suffix). Required when good_qty >= 1. */
  output_lot_number?: string;
  lines: ProduceLineInput[];
  /** Signed write (action kit.produce). */
  evidence_id: string;
  reason: string;
}

export interface CloseOutInput {
  good_qty: number;
  scrap_qty: number;
  /** Multi-destination output (split across locations). Empty when good_qty is 0. */
  outputs: OutputDestinationInput[];
  /** Expiry of the produced lot (REQ-2026-07-01-INV-008). ISO yyyy-mm-dd. */
  output_expiration_date?: string | null;
  /** Operator-entered lot number for the final produced batch (client 2026-07-24).
   *  Required when good_qty >= 1; omitted for a good-0 close (no lot minted). */
  output_lot_number?: string;
  lines: CloseOutLineInput[];
  /** Signed write. */
  evidence_id: string;
  reason: string;
}

/** One place a slice of a line's returned material goes. Mirrors
 *  `OutputDestinationInput` — material coming off the floor may be SPLIT across
 *  locations when no single box has enough free cells (client 2026-07-30). */
export interface ReturnDestinationInput {
  location_node_id: string;
  qty: number;
  return_cells?: ReturnCellInput[];
}

export interface CancelLineInput {
  line_id: string;
  /** Wins when present; must total the line's on-floor quantity. */
  destinations?: ReturnDestinationInput[];
  /** The single-location path, kept for callers that don't split. */
  return_location_node_id?: string;
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
    params: { status?: KitStatus; q?: string; limit?: number; offset?: number } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<ApiKitListResponse>('/kits', {
      query: {
        status: params.status ?? undefined,
        q: params.q?.trim() || undefined,
        limit: params.limit ?? undefined,
        offset: params.offset ?? undefined,
      },
      signal: opts?.signal,
    }),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiKit>(`/kits/${id}`, { signal: opts?.signal }),

  activity: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiKitActivityResponse>(`/kits/${id}/activity`, { signal: opts?.signal }),

  /** Per-ITEM kit audit history — every kit this item took part in (AUD-001). */
  itemAudit: (itemId: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiItemKitAuditResponse>(`/kits/by-item/${itemId}/audit`, { signal: opts?.signal }),

  /** Open kits building on a production floor + their on-floor material. */
  /** What each kit actually USED of this item — the reconciliation the Unit
   *  Ledger can't show on its own (consumption writes no stock movement). */
  itemConsumption: (itemId: string, opts?: { signal?: AbortSignal }) =>
    api.get<{ lines: ApiItemKitConsumption[] }>(`/kits/by-item/${itemId}/consumption`, {
      signal: opts?.signal,
    }),

  /** One page of one section of a production floor, plus every tab's count. */
  onFloor: (
    nodeId: string,
    opts?: { section?: FloorSection; limit?: number; offset?: number; signal?: AbortSignal },
  ) =>
    api.get<ApiFloorKitsResponse>(`/kits/floor/${nodeId}`, {
      query: { section: opts?.section, limit: opts?.limit, offset: opts?.offset },
      signal: opts?.signal,
    }),

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

  /** Produce a batch and keep the kit open (e-signed). */
  produce: (id: string, input: ProduceInput) =>
    api.post<ApiKit>(`/kits/${id}/produce`, { json: input }),

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
