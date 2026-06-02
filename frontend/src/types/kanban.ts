import type { KanbanStageId } from '@/config/inventory';
import type { InventoryItem } from './inventory';

export interface KanbanCardData {
  itemId: string;
  stage: KanbanStageId;
  item: InventoryItem;
  vendor: string;
  qty: number;
  onOrder: number;
  threshold: number;
  poNote?: string;
  poDue?: string;
}
