/**
 * Consumables / Kanban / expiration API client — `/v1/consumables`
 * (docs/modules/consumables.md).
 *
 * Three rules from the requirements shape this surface, and they explain why
 * some obvious endpoints are missing:
 *
 *  * an issue is TERMINAL for quantity (07-09 TRX-001) — there is no de-issue;
 *  * consumables are NEVER back-flushed (07-09 TRX-004) — there is no return;
 *  * expiration keeps being tracked after the quantity is gone (TX Spec §4.3) —
 *    which is what the register below is.
 *
 * Only the issue is e-signed (`evidence_id`); acknowledging a flag is a "simple
 * acknowledgment" per TRX-006 and moves no stock.
 */
import { api } from './client';
import type { CellOption } from './kits';

/** How close to its expiry a row is. `null` = comfortably in date, or no date
 *  at all (07-09: "expiration flags apply only where a date exists"). */
export type ExpiryFlag = 'warn' | 'expired';

/** Transaction Spec §4.2's outcomes for a physical check. */
export type Disposition = 'consumed' | 'reworked' | 'retested' | 'discarded';

export const DISPOSITIONS: readonly Disposition[] = [
  'consumed',
  'reworked',
  'retested',
  'discarded',
];

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  consumed: 'Consumed before expiry',
  reworked: 'Removed — reworked',
  retested: 'Removed — retested',
  discarded: 'Removed — discarded',
};

/** One issuable source — a consumable lot at a storage location. */
export interface ConsumableSource {
  lot_id: string;
  lot_number: string | null;
  expiration_date: string | null;
  node_id: string;
  /** Human path, e.g. "Warehouse One › Shelf B". */
  location: string;
  qty: number;
  /** An LN2 box source: the operator taps the exact vials and the quantity
   *  follows, same as a kit issue. Consumables usually sit on a shelf, but not
   *  always — CR-004 is stored in Tank 1 (client 2026-08-11). */
  is_grid: boolean;
  grid_rows: number | null;
  grid_cols: number | null;
  /** This lot's occupied positions in that box. Empty for a bulk source. */
  cells: CellOption[];
}

/** One source pick on an issue. Several may be sent at once when the operator
 *  empties a part-used lot before opening a fresh one — each becomes its own
 *  register row so the two expiry dates stay independent. */
export interface ConsumableSourceInput {
  node_id: string;
  lot_id: string;
  qty: number;
  /** Box sources only, and required for them: the exact vials to empty. `qty`
   *  must equal their count — the backend rejects a box source without them
   *  rather than draining the lot FIFO. */
  cell_allocation_ids?: string[];
}

export interface ConsumableIssueInput {
  sources: ConsumableSourceInput[];
  /** Always a Kanban node, never the production area itself. */
  kanban_node_id: string;
  evidence_id: string;
  notes?: string | null;
}

export interface IssueResultLine {
  lot_id: string;
  lot_number: string | null;
  qty: number;
  expiration_date: string | null;
}

export interface ConsumableIssueResult {
  item_id: string;
  item_number: string;
  total_qty: number;
  kanban_node_id: string;
  kanban_path: string;
  performed_at: string;
  lines: IssueResultLine[];
}

/** One row of the Kanban register. Everything here except the `cleared_*`
 *  fields is derived server-side from the ledger movement, so it cannot drift
 *  from what actually happened. */
export interface IssuedConsumable {
  id: string;
  item_id: string;
  item_number: string;
  item_description: string | null;
  lot_number: string | null;
  qty: number;
  kanban_node_id: string;
  kanban_name: string;
  kanban_path: string;
  issued_at: string;
  issued_by: string | null;
  expiration_date: string | null;
  flag: ExpiryFlag | null;
  /** Negative once past the date; null when there is no date to count to. */
  days_to_expiry: number | null;
  cleared_at: string | null;
  cleared_by: string | null;
  disposition: Disposition | null;
  clear_note: string | null;
}

/** A page of the register. Same envelope as the item list, so the shared
 *  paginator drives it unchanged. */
export interface IssuedConsumableList {
  items: IssuedConsumable[];
  total: number;
  limit: number;
  offset: number;
}

export interface AcknowledgeInput {
  disposition: Disposition;
  note?: string | null;
}

export interface ExpiryPolicy {
  warn_days: number;
}

function qs(params: Record<string, string | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const consumablesApi = {
  /** Issuable stock for one consumable. 422 `item_not_consumable` if the item
   *  isn't flagged — a non-consumable goes to production on a kit instead. */
  sources: (itemId: string, opts?: { signal?: AbortSignal }) =>
    api.get<ConsumableSource[]>(`/consumables/sources/${itemId}`, { signal: opts?.signal }),

  /** The register. Without `kanbanNodeId` this spans every Kanban. */
  issued: (
    params: { kanbanNodeId?: string; itemId?: string; includeCleared?: boolean } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<IssuedConsumable[]>(
      `/consumables/issued${qs({
        kanban_node_id: params.kanbanNodeId,
        item_id: params.itemId,
        include_cleared: params.includeCleared,
      })}`,
      { signal: opts?.signal },
    ),

  /** The alert feed — everything warning or expired, across all Kanbans.
   *  Paged server-side: the register only ever grows. */
  expiring: (
    params: { limit?: number; offset?: number } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<IssuedConsumableList>(
      `/consumables/expiring${qs({
        limit: params.limit === undefined ? undefined : String(params.limit),
        offset: params.offset === undefined ? undefined : String(params.offset),
      })}`,
      { signal: opts?.signal },
    ),

  /** E-signed. Action verb: `movement.consumable_issue`. */
  issue: (input: ConsumableIssueInput) =>
    api.post<ConsumableIssueResult>('/consumables/issue', { json: input }),

  /** Clear a flag after the physical check. Not e-signed (TRX-006). */
  acknowledge: (issueId: string, input: AcknowledgeInput) =>
    api.post<IssuedConsumable>(`/consumables/${issueId}/acknowledge`, { json: input }),

  expiryPolicy: (opts?: { signal?: AbortSignal }) =>
    api.get<ExpiryPolicy>('/consumables/expiry-policy', { signal: opts?.signal }),

  setExpiryPolicy: (warnDays: number) =>
    api.put<ExpiryPolicy>('/consumables/expiry-policy', { json: { warn_days: warnDays } }),
};

/** The e-sign action verb the issue dialog must mint evidence for. */
export const CONSUMABLE_ISSUE_ACTION = 'movement.consumable_issue';
