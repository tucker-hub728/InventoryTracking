/**
 * API → UI shape conversion for inventory items.
 *
 * The wire shape (``ApiItem``) carries Postgres NUMERIC as strings,
 * snake_case keys, and the API status codes (``available`` / ``low_stock``
 * / ``out_of_stock``). The UI's ``InventoryItem`` was designed around the
 * Excel-converted seed: numbers as numbers, camelCase keys, full-word
 * status labels (``Available`` / ``Low stock`` / ``Out of stock``).
 *
 * This adapter is the *only* place those translations happen. Components
 * never see ``ApiItem``; the store transforms on fetch and only stores
 * ``InventoryItem`` instances.
 *
 * Fields that haven't shipped yet on the backend (``location``, ``lot``,
 * ``expires``, ``months``, ``onOrder``, ``mustOrder``) get safe placeholder
 * values until lots / batches / ledger / forecast modules land.
 */

import { STOCK_STATUS_META } from '@/config/inventory';
import type { InventoryItem } from '@/types/inventory';

import type { ApiItem } from './items';

/** Convert a numeric-string from the API to a plain number. */
function num(s: string | null | undefined, fallback = 0): number {
  if (s == null || s === '') return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

export function apiItemToInventoryItem(api: ApiItem): InventoryItem {
  return {
    // The UI keys items by ``item_number`` (e.g. ``CM-0001``) — that's
    // what URLs, sorts, and table rows use. We surface the backend UUID
    // separately for endpoints that demand it (e.g. ``/items/{uuid}/ledger``).
    id: api.item_number,
    uuid: api.id,
    desc: api.description,
    // Items can have multiple assigned vendors — show them joined. Empty
    // when the item has no vendors yet.
    vendor: api.vendors.map((v) => v.vendor_name).join(', '),
    lead: api.avg_lead_days ?? 0,
    invValue: num(api.inv_value_amount),
    poValue: num(api.po_value_amount),
    qty: num(api.qty_on_hand),
    qtyAvailable: num(api.qty_available),
    months: null, // forecast module
    onOrder: num(api.qty_on_order),
    mustOrder: api.must_order_flag ? 1 : 0,
    nearExpiryThresholdDays: api.near_expiry_threshold_days ?? 30,
    // Batch dimensions land with the movements module.
    location: '',
    lot: '',
    expires: '',
    threshold: num(api.reorder_threshold),
    status: STOCK_STATUS_META[api.status_code]?.label ?? 'Out of stock',
    // "Updated" in the table means "row last modified" — sortable on
    // the backend by ``updated_at``. The previous fallback to
    // ``last_movement_at`` showed a recent date that didn't match
    // the sort key (sorting by updated_at could land an item with a
    // newer movement above an item with a newer row mutation).
    // Movement-recency lives on the detail page snapshot card instead.
    updatedAt: api.updated_at,
  };
}
