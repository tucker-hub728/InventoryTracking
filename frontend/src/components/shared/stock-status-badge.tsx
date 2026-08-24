import { PackageCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { AWAITING_RELEASE_META } from '@/config/inventory';
import type { InventoryStatus } from '@/types/inventory';

/**
 * An item's stock status, aware of material that has arrived but is not yet
 * shelved (REQ-004).
 *
 * The problem this solves: "Low stock" is a *procurement* signal — it means buy
 * more. When a delivery is sitting in quarantine waiting to be received to
 * inventory, buying more is exactly the wrong move, and the item page was
 * showing "Low stock" directly above a banner saying fifteen thousand units had
 * arrived. Two true statements that read as a contradiction, and the one people
 * act on was the misleading one.
 *
 * The awkward part is that two different people ask two different questions of
 * the same badge:
 *
 *   * an operator asks "can I take units today?" — and the honest answer is
 *     still no, nothing is on a shelf;
 *   * a planner asks "should I raise an order?" — and the honest answer is no,
 *     it is already here.
 *
 * So the badge answers the second, and the Snapshot beside it keeps answering
 * the first: Available still reads 20, On hand still reads 20, and the
 * receive-to-inventory banner still says what is waiting. Nothing is hidden —
 * what changes is which
 * of the two facts gets the loud, coloured pill, and the tie goes to the one
 * with an action attached. "Awaiting release" is a to-do; "Low stock" is a
 * purchase order.
 *
 * It only takes over when the waiting material actually covers the shortfall.
 * A part-covered item still needs an order, so it keeps its warning — the
 * Reorder screen shows how much has already landed so the order is raised for
 * the difference.
 *
 * Accent, not warning: material arriving and waiting to be shelved is the
 * ordinary path. Colouring it as an alert would put a yellow pill on most items
 * on most delivery days and teach people to ignore the colour that should mean
 * stop — the same reasoning the receive-to-inventory banner records for staying neutral.
 */
export function StockStatusBadge({
  status,
  qtyAvailable,
  reorderThreshold,
  qtyAwaitingRelease,
  className,
}: {
  status: InventoryStatus;
  qtyAvailable: number;
  reorderThreshold: number;
  /** Units arrived but not placed. 0 when nothing is waiting. */
  qtyAwaitingRelease: number;
  className?: string;
}) {
  if (!coveredByArrivals({ status, qtyAvailable, reorderThreshold, qtyAwaitingRelease })) {
    return <StatusBadge status={status} />;
  }
  return (
    <Badge
      // Tone and label from the shared config, never chosen here — see
      // INVENTORY_STATUS_TONE for why nothing picks its own status colour.
      tone={AWAITING_RELEASE_META.tone}
      className={className}
      // The number is the point — "awaiting release" without it just moves the
      // question along. The Snapshot is one glance away for the rest.
      title={`${qtyAwaitingRelease.toLocaleString()} units have arrived and are waiting to be received to inventory. Receive them rather than ordering more — ${qtyAvailable.toLocaleString()} of ${reorderThreshold.toLocaleString()} are available right now.`}
    >
      <PackageCheck size={11} />
      {AWAITING_RELEASE_META.label}
    </Badge>
  );
}

/**
 * Whether arrived-but-unshelved stock would clear this item's shortfall.
 *
 * Mirrors the backend's ``_covered_by_arrivals`` so the badge and the Reorder
 * screen classify an item the same way. Exported because the Reorder rows need
 * the same test without rendering a badge.
 */
export function coveredByArrivals({
  status,
  qtyAvailable,
  reorderThreshold,
  qtyAwaitingRelease,
}: {
  status: InventoryStatus;
  qtyAvailable: number;
  reorderThreshold: number;
  qtyAwaitingRelease: number;
}): boolean {
  if (qtyAwaitingRelease <= 0) return false;
  // Only ever displaces a shortage. An item comfortably in stock keeps saying
  // Available — a delivery on top of a healthy shelf is not news.
  if (status !== 'Low stock' && status !== 'Out of stock') return false;
  // ">=" because covering the gap exactly is enough: releasing it puts the item
  // back on its threshold, which is where it is meant to sit.
  return qtyAwaitingRelease >= reorderThreshold - qtyAvailable;
}
