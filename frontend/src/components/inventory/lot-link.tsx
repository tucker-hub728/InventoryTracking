'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { lotsApi } from '@/lib/api/lots';
import { cn } from '@/lib/utils';

interface Props {
  /** Lot to trace back to its intake. Plain text is rendered when absent. */
  lotId: string | null | undefined;
  /** Display text; falls back to a short form of the id, then an em dash. */
  lotNumber: string | null | undefined;
  className?: string;
}

/**
 * A lot number that navigates to the receiving order that created it, opening
 * that order's detail sheet at `/receiving/<transaction id>`.
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
      if (!lot.receipt_transaction_id) {
        toast.info('No receiving order', {
          description: `Lot ${lot.lot_number} wasn't created by a receipt.`,
        });
        return;
      }
      router.push(`/receiving/${lot.receipt_transaction_id}`);
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
      title={`Open the receiving order for lot ${label}`}
      className={cn(
        'text-accent underline-offset-2 transition-opacity hover:underline hover:opacity-80 disabled:opacity-50',
        className,
      )}
    >
      {label}
    </button>
  );
}
