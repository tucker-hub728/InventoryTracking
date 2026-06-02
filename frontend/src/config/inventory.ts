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

/**
 * Category code ↔ label map. Codes drive auto-generated Item IDs
 * (e.g. "CR-0473"). Order is the order shown in the New-item card grid.
 */
export const CATEGORY_OPTIONS = [
  { code: 'CM', label: 'Cell-therapy media / reagent' },
  { code: 'NM', label: 'Manufacturing reagent' },
  { code: 'CR', label: 'Consumable / equipment' },
  { code: 'AY', label: 'Assay / QC reference' },
] as const;

export type CategoryCode = (typeof CATEGORY_OPTIONS)[number]['code'];

export const CATEGORY_CODE_BY_LABEL: Record<string, CategoryCode> =
  Object.fromEntries(CATEGORY_OPTIONS.map((c) => [c.label, c.code])) as Record<
    string,
    CategoryCode
  >;

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
