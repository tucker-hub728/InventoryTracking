import type { BadgeTone } from '@/types/ui';
import type { InventoryItem } from '@/types/inventory';
import type { User } from '@/types/auth';
import type { KanbanStageId } from '@/config/inventory';
import { mockData } from '@/lib/mock-data';

const hash = (s: string): number => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
};

export interface PriorityInfo {
  label: string;
  tone: BadgeTone;
}

export function priorityFor(it: InventoryItem): PriorityInfo {
  if (it.status === 'Out of stock') return { label: 'Critical', tone: 'danger' };
  if (it.status === 'Expiring') return { label: 'High', tone: 'warning' };
  if (it.status === 'Low stock') return { label: 'High', tone: 'warning' };
  if (it.qty <= (it.threshold || 0) * 2) return { label: 'Medium', tone: 'accent' };
  return { label: 'Low', tone: 'accent' };
}

export function reasonFor(it: InventoryItem, col: KanbanStageId): string {
  if (col === 'low_stock') {
    if (it.qty === 0) return 'Critical stock — 0 units remaining';
    if (it.qty <= (it.threshold || 1))
      return `Critical stock — ${it.qty} unit${it.qty === 1 ? '' : 's'} remaining`;
    return 'Below reorder threshold';
  }
  if (col === 'review')
    return it.status === 'Expiring' ? 'Near expiration + low stock' : 'Quality review pending';
  if (col === 'pending') return 'Awaiting manager approval';
  if (col === 'ordered')
    return it.onOrder > 0 ? `PO sent · ${it.onOrder} on order` : 'PO sent to supplier';
  if (col === 'received') return 'Routine restock';
  if (col === 'closed') return 'Workflow complete';
  return '';
}

export function initialStageFor(it: InventoryItem): KanbanStageId {
  if (it.status === 'Out of stock' && (it.onOrder || 0) === 0) return 'low_stock';
  if (it.status === 'Low stock' && (it.onOrder || 0) === 0) return 'low_stock';
  if ((it.onOrder || 0) > 0) return 'ordered';
  if (it.status === 'Expiring') return 'review';
  const buckets: KanbanStageId[] = ['received', 'closed', 'pending', 'received', 'closed'];
  return buckets[hash(it.id) % buckets.length]!;
}

export function assigneeFor(it: InventoryItem): User {
  const candidates = mockData.users.filter(
    (u) => (u.role === 'admin' || u.role === 'editor') && u.status === 'active',
  );
  if (candidates.length === 0) return mockData.users[0]!;
  return candidates[hash(it.id) % candidates.length]!;
}

/** Pre-built initial board: itemId → column. */
export function buildInitialBoard(): Record<string, KanbanStageId> {
  const out: Record<string, KanbanStageId> = {};
  mockData.items
    .filter((i) => i.qty > 0 || i.status === 'Out of stock' || i.status === 'Expiring')
    .forEach((it) => {
      out[it.id] = initialStageFor(it);
    });
  return out;
}
