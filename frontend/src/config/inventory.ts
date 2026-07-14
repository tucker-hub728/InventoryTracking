import type { BadgeTone } from '@/types/ui';
import type { InventoryStatus } from '@/types/inventory';

export const INVENTORY_STATUS_TONE: Record<InventoryStatus, BadgeTone> = {
  Available: 'success',
  'Low stock': 'warning',
  Expiring: 'warning',
  Quarantine: 'danger',
  Expired: 'danger',
  'Out of stock': 'neutral',
};

export const INVENTORY_STATUSES: readonly InventoryStatus[] = [
  'Available',
  'Low stock',
  'Expiring',
  'Quarantine',
  'Expired',
  'Out of stock',
] as const;

/** Backend stock-status codes (from ``v_item_stock.status_code``). */
export type StockStatusCode = 'available' | 'low_stock' | 'out_of_stock';

/**
 * Canonical label + tone for each stock-status code — the single source
 * of truth for how a stock status is rendered. Every surface that shows
 * one (the inventory list, the product materials panel, the material
 * dialog) reads from here, so naming *and* colour stay identical across
 * views. ``label`` doubles as the ``InventoryStatus`` the StatusBadge
 * expects; ``tone`` is pulled from ``INVENTORY_STATUS_TONE`` so the
 * colour is single-sourced too.
 */
export const STOCK_STATUS_META: Record<
  StockStatusCode,
  { label: InventoryStatus; tone: BadgeTone }
> = {
  available: { label: 'Available', tone: INVENTORY_STATUS_TONE.Available },
  low_stock: { label: 'Low stock', tone: INVENTORY_STATUS_TONE['Low stock'] },
  out_of_stock: { label: 'Out of stock', tone: INVENTORY_STATUS_TONE['Out of stock'] },
};

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export const KANBAN_STAGES = [
  { id: 'low_stock', label: 'Low Stock Detected', tone: 'warning' as const },
  { id: 'review', label: 'Needs Review', tone: 'warning' as const },
  { id: 'pending', label: 'Pending Approval', tone: 'accent' as const },
  { id: 'ordered', label: 'Ordered', tone: 'accent' as const },
  { id: 'received', label: 'Received', tone: 'success' as const },
  { id: 'closed', label: 'Closed', tone: 'neutral' as const },
] as const;

export type KanbanStageId = (typeof KANBAN_STAGES)[number]['id'];

export const KANBAN_STAGE_BY_ID: Record<
  KanbanStageId,
  (typeof KANBAN_STAGES)[number]
> = Object.fromEntries(KANBAN_STAGES.map((s) => [s.id, s])) as never;
