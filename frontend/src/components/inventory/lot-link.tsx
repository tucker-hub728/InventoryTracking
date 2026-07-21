'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { lotsApi } from '@/lib/api/lots';
import { movementsApi } from '@/lib/api/movements';
import { cn } from '@/lib/utils';

interface Props {
  /** Lot to trace back to its intake. Plain text is rendered when absent. */
  lotId: string | null | undefined;
  /** Display text; falls back to a short form of the id, then an em dash. */
  lotNumber: string | null | undefined;
  className?: string;
}

/**
 * A lot number that navigates to whatever created it:
 *
 *  * received stock → the receiving order, at `/receiving/<transaction id>`
 *  * manufactured stock → the kit that produced it, at `/reconciliation/<kit id>`
 *
 * Kitting made the second case common — a close-out mints a lot for the
 * produced AY/FG, which has no receipt behind it. Treating that as "no
 * receiving order" was accurate but a dead end, since the kit is exactly the
 * origin the operator is looking for.
 *
 * The owning order is resolved on click rather than on render: most callers
 * have only a `lot_id` in scope (movements and allocations don't carry the
 * transaction id), so resolving eagerly would cost one request per row in
 * tables and grids that render many lots. The trade is that a lot with no
 * order — admin-created, seeded, or orphaned when its order was deleted, since
 * `lots.receipt_transaction_id` is `ON DELETE SET NULL` — can only be reported
 * after the click.
 */
export function LotLink({ lotId, lotNumber, className }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const label = lotNumber ?? lotId?.slice(0, 8) ?? '—';

  // Nothing to resolve against — render the label as-is rather than a control
  // that can only fail.
  if (!lotId) return <span className={className}>{label}</span>;

  const go = async (e: React.MouseEvent) => {
    // Several call sites sit inside clickable rows and cells.
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const lot = await lotsApi.get(lotId);
      if (lot.receipt_transaction_id) {
        router.push(`/receiving/${lot.receipt_transaction_id}`);
        return;
      }
      // Not received — it may have been *manufactured*. A kit's close-out mints
      // a lot for the produced AY/FG, so the equivalent "where did this come
      // from" answer is the kit, not a receiving order. Resolved through the
      // ledger because lots carry no kit reference of their own.
      const { items } = await movementsApi.list({ lotId, limit: 50 });
      const madeBy = items.find((m) => m.movement_type === 'production_output' && m.kit_id);
      if (madeBy?.kit_id) {
        router.push(`/reconciliation/${madeBy.kit_id}`);
        return;
      }
      toast.info('No order or kit', {
        description: `Lot ${lot.lot_number} wasn't created by a receipt or a kit — it was entered directly.`,
      });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not open the order for this lot.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      title={`Open where lot ${label} came from`}
      className={cn(
        'text-accent underline-offset-2 transition-opacity hover:underline hover:opacity-80 disabled:opacity-50',
        className,
      )}
    >
      {label}
    </button>
  );
}
