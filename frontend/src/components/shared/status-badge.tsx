import { Badge } from '@/components/ui/badge';
import { INVENTORY_STATUS_TONE } from '@/config/inventory';
import type { InventoryStatus } from '@/types/inventory';

/**
 * Resolved Badge for an inventory status — single place to map status →
 * tone so the visual language stays consistent.
 */
export function StatusBadge({ status }: { status: InventoryStatus }) {
  const tone = INVENTORY_STATUS_TONE[status] ?? 'neutral';
  return (
    <Badge tone={tone} dot>
      {status}
    </Badge>
  );
}
