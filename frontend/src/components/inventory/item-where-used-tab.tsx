'use client';

import * as React from 'react';
import Link from 'next/link';

import { useMinDuration } from '@/hooks/use-min-duration';
import { EmptyState } from '@/components/shared/empty-state';
import { TableSkeleton } from '@/components/shared/table-skeleton';
import { ApiError } from '@/lib/api/client';
import { bomApi, type ApiWhereUsed } from '@/lib/api/bom';
import { formatNumber } from '@/lib/utils';

interface Props {
  itemId: string;
}

/**
 * "Used in" tab — the Products whose bill of materials consume this item.
 *
 * Shown for non-consumable raw materials and for built tiers alike: an AY can
 * be a component of an FG, while a top-level FG simply lists none.
 */
export function ItemWhereUsedTab({ itemId }: Props) {
  const [whereUsed, setWhereUsed] = React.useState<ApiWhereUsed[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Held briefly — the fetch returns in ~20ms, too fast to see otherwise.
  const showSkeleton = useMinDuration(loading && whereUsed.length === 0);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    bomApi
      .whereUsed(itemId, { signal: ctrl.signal })
      .then((used) => setWhereUsed(used))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load usage.');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [itemId]);

  if (error) return <EmptyState title="Couldn't load usage" hint={error} />;
  if (showSkeleton) {
    return (
      <div className="p-4">
        <TableSkeleton
          rows={3}
          columns={3}
          className="rounded-lg border border-border"
          label="Loading usage…"
        />
      </div>
    );
  }
  if (whereUsed.length === 0) {
    return (
      <EmptyState
        title="Not used in any Product"
        hint="This item isn't consumed by any Product's bill of materials."
      />
    );
  }

  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface text-left text-[11px] uppercase tracking-wider text-text-3">
              <th className="px-4 py-2.5 font-medium">Item</th>
              <th className="px-4 py-2.5 font-medium">Description</th>
              <th className="px-4 py-2.5 text-right font-medium">Qty / unit</th>
            </tr>
          </thead>
          <tbody>
            {whereUsed.map((p) => (
              <tr key={p.parent_item_id} className="border-border/60 border-b last:border-b-0">
                <td className="px-4 py-2.5">
                  <Link
                    href={`/inventory/${encodeURIComponent(p.parent_item_number)}/ledger`}
                    className="font-mono text-xs text-accent hover:underline"
                  >
                    {p.parent_item_number}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-text-2">{p.parent_description}</td>
                <td className="px-4 py-2.5 text-right font-mono text-text-2">
                  ×{formatNumber(Number(p.qty_per_unit))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
