/**
 * Planning API client — `/v1/planning` (PLN-001).
 *
 * "Each item shall carry a reorder threshold and a supplier lead time; the
 * planning module shall warn when on-hand reaches the threshold so long-lead
 * items can be reordered in time."
 *
 * Read-only: this surface warns, it does not raise orders. Ordering lives on
 * `/receiving`, which has its own e-signature.
 *
 * NOT the same thing as `./forecasts`. The sidebar has called the forecast
 * screen "Planning" since it shipped; that one projects demand, this one
 * reports a threshold that has already been crossed.
 */
import { api } from './client';

/** One item that has reached its reorder threshold. */
export interface ReorderRow {
  item_id: string;
  item_number: string;
  description: string;
  uom: string;
  /** Consume units (Each) — the same basis the threshold is stored in. */
  qty_available: string;
  reorder_threshold: string;
  /** `reorder_threshold - qty_available`, floored at zero. */
  shortfall: string;
  status_code: 'low_stock' | 'out_of_stock';
  suppliers: { supplier_id: string; supplier_name: string }[];
  /** Longest lead time among the item's suppliers — worst case, so the warning
   *  is early enough even if the slow supplier is the one you end up using.
   *  `null` means no supplier has one recorded, which is a data gap and NOT
   *  the same as zero days. */
  lead_time_days: number | null;
  /** Which supplier `lead_time_days` came from, so the number is attributable. */
  lead_time_supplier_name: string | null;
  /** Units already on site but not yet shelved (REQ-004). When this covers the
   *  shortfall the row is in `awaiting_release` instead of `items`. */
  qty_awaiting_release: string;
  /** Units on open purchase orders, in consume units. When this covers the
   *  shortfall the row sits under `on_order` — already bought, do not buy
   *  again. */
  qty_on_order: string;
  /** ISO date the earliest open order should land — its order date plus that
   *  line's own supplier's lead time. `null` when nothing is outstanding or
   *  that supplier has no lead time recorded; render as unknown, never as
   *  "arriving today". */
  expected_arrival: string | null;
  /** The purchase order that date belongs to, so a row can link straight to
   *  the screen where it is received. Paired with the date on purpose — an item
   *  with two open orders must not show one order's reference beside the
   *  other's date. */
  next_order_id: string | null;
  next_po_reference: string | null;
  /** Total open orders. Above 1, the date and reference are the soonest of
   *  several rather than the only one. */
  open_order_count: number;
}

/**
 * Which question a row answers.
 *
 *  * `order`    — nothing is coming; raise a purchase order.
 *  * `on_order` — a purchase order is already open; wait or chase it.
 *  * `awaiting` — already delivered, just not shelved; receive it to inventory.
 */
export type ReorderGroup = 'order' | 'on_order' | 'awaiting';

export interface ReorderList {
  /** Rows for the requested group only. */
  items: ReorderRow[];
  /** Unpaged size of the requested group — what the paginator divides. */
  total: number;
  limit: number;
  offset: number;
  /** Echoed back, so a slow response arriving after a tab switch can be
   *  discarded instead of rendered under the wrong tab. */
  group: ReorderGroup;
  /** Unpaged size of each group, for the tab labels. Both arrive every time so
   *  the tab you are NOT on can still show its count. */
  order_total: number;
  on_order_total: number;
  awaiting_total: number;
  /** Live items still on a zero threshold — absent from `items` by design.
   *  Reported so an empty list can't be misread: "nothing to order" and
   *  "nothing configured" look identical otherwise. */
  items_without_threshold: number;
  /** Rows on this page with no lead time recorded anywhere. */
  rows_without_lead_time: number;
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const planningApi = {
  /**
   * One page of one group. `limit`/`offset` apply to that group alone, so the
   * two tabs page independently.
   */
  reorder: (
    params: { group?: ReorderGroup; limit?: number; offset?: number } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<ReorderList>(
      `/planning/reorder${qs({
        group: params.group,
        limit: params.limit === undefined ? undefined : String(params.limit),
        offset: params.offset === undefined ? undefined : String(params.offset),
      })}`,
      { signal: opts?.signal },
    ),
};
