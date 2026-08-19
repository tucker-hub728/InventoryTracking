/**
 * Material-issue API — wraps ``/api/v1/issues`` (REQ-2026-08-04-TRX-001/002).
 *
 * Issue is **debit-and-gone**: the material leaves controlled inventory and
 * nothing is stored at the destination. It is a different transaction from a
 * transfer, and the difference is what the operator picks as the destination:
 *
 *     Transfer → QC 1 › Freezer 1     still inventory, at a new node
 *     Issue    → QC 1                 gone from inventory
 *
 * So this API takes a LOCATION id, while `locationNodesApi.transfer*` take a
 * storage node. The server accepts disjoint node types for the two, which is
 * what makes "issued and also sitting in the QC freezer" impossible to ask for
 * rather than merely refused.
 *
 * Sibling of `consumables.ts`, which issues a CONSUMABLE to a KANBAN and keeps
 * an expiration flag afterwards. This one issues any item to a location and
 * keeps nothing.
 */

import { api } from './client';

/** The reauth action verb minted before an issue — matched server-side. */
export const MATERIAL_ISSUE_ACTION = 'movement.material_issue';

/** A location material may be issued to (a location created with the
 *  debit-and-gone option ticked). */
export interface IssueDestination {
  node_id: string;
  name: string;
  code: string;
  /** Full breadcrumb, e.g. "Storage › QC 1 Analytical Lab". */
  path: string;
}

/** One occupied vial in an LN2 box — the operator taps these to choose exactly
 *  which vials leave. */
export interface IssueCell {
  allocation_id: string;
  grid_row: number;
  grid_col: number;
  lot_id: string;
  lot_number: string | null;
  expiration_date: string | null;
}

/** One issuable source — a lot at a storage location with its available qty. */
export interface IssueSource {
  lot_id: string;
  lot_number: string | null;
  expiration_date: string | null;
  node_id: string;
  location: string;
  qty: number;
  is_grid: boolean;
  grid_rows: number | null;
  grid_cols: number | null;
  cells: IssueCell[];
}

/** One source pick. For a box, `cell_allocation_ids` names the exact vials and
 *  `qty` must equal their count; a bulk lot drains FIFO. */
export interface IssueSourceInput {
  node_id: string;
  lot_id: string;
  qty: number;
  cell_allocation_ids?: string[];
}

export interface IssueInput {
  sources: IssueSourceInput[];
  /** The LOCATION (PD, R&D, QC 1) — never a shelf / refrigerator / freezer
   *  inside it. The server rejects a sub-location with
   *  `issue_target_not_location`. */
  destination_node_id: string;
  /** Terminal + e-signed (action `movement.material_issue`). */
  evidence_id: string;
  /** Optional comment, as in every other flow. */
  notes?: string | null;
}

/**
 * One row of a location's disposition log.
 *
 * Read it as HISTORY, never as a holding. There is no node to drill into and no
 * balance, because the material left inventory the moment this row was written.
 * Anything that renders it must not imply the units are sitting at the location.
 */
export interface IssuedRow {
  movement_id: string;
  item_id: string;
  item_number: string;
  item_description: string | null;
  lot_id: string | null;
  lot_number: string | null;
  qty: number;
  /** Where it was drawn FROM — a snapshot taken when the row was written, so it
   *  survives that shelf being renamed or removed. */
  source_path: string | null;
  issued_at: string;
  issued_by: string | null;
  notes: string | null;
}

export interface IssuedList {
  items: IssuedRow[];
  /** Rows in the WHOLE log, not this page. */
  total: number;
  /** Units in the whole log — a figure that must not change when you page. */
  total_qty: number;
  limit: number;
  offset: number;
}

export interface IssueLine {
  lot_id: string;
  lot_number: string | null;
  qty: number;
}

export interface IssueResult {
  item_id: string;
  item_number: string;
  total_qty: number;
  destination_node_id: string;
  destination_name: string;
  destination_path: string;
  performed_at: string;
  lines: IssueLine[];
}

/** What one debit-and-gone location has consumed. Absent from the list
 *  entirely when nothing has been issued there yet. */
export interface IssuedSummary {
  node_id: string;
  issue_count: number;
  total_qty: number;
  last_issued_at: string | null;
}

export const issuesApi = {
  /** Locations material may be issued to. An EMPTY list is a real state, not an
   *  error: it means no debit-and-gone location has been created yet, and the
   *  UI should say so rather than show an empty picker. */
  destinations: (opts?: { signal?: AbortSignal }) =>
    api.get<IssueDestination[]>('/issues/destinations', { signal: opts?.signal }),

  sources: (itemId: string, opts?: { signal?: AbortSignal }) =>
    api.get<IssueSource[]>(`/issues/sources/${itemId}`, { signal: opts?.signal }),

  /** Per-destination totals for the Storage overview. One call for every card —
   *  a debit-and-gone location holds nothing, so its card shows what it has
   *  TAKEN, and asking per card would be a round trip each. */
  summary: (opts?: { signal?: AbortSignal }) =>
    api.get<IssuedSummary[]>('/issues/summary', { signal: opts?.signal }),

  /** What has been issued TO a location — its disposition log, newest first.
   *  Not `/location-nodes/{id}/allocations`, which is stock actually held at a
   *  node: at a scrap location these are two opposite facts about one place. */
  issuedAt: (
    nodeId: string,
    opts?: { limit?: number; offset?: number; signal?: AbortSignal },
  ) =>
    api.get<IssuedList>(`/issues/at/${nodeId}`, {
      query: { limit: opts?.limit ?? 50, offset: opts?.offset ?? 0 },
      signal: opts?.signal,
    }),

  issue: (input: IssueInput) => api.post<IssueResult>('/issues', { json: input }),
};
