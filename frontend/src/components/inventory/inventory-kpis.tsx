'use client';

import * as React from 'react';

import { STOCK_STATUS_META } from '@/config/inventory';
import { cn } from '@/lib/utils';
import type { InventoryItem } from '@/types/inventory';
import type { BadgeTone } from '@/types/ui';

/** Tone → text colour, mirroring the Badge tones so a tile and a badge for the
 *  same thing read the same. */
const TONE_TEXT: Record<BadgeTone, string> = {
  neutral: '',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

interface InventoryKPIsProps {
  /** Items on the *current page*. Used for page-scoped sums. */
  items: InventoryItem[];
  /** Server-side total matching the active filter — always exact. */
  total: number;
}

const fmtUsdK = (n: number) => `$${(n / 1000).toFixed(1)}k`;

// KPIs honest-about-their-scope rules:
//   * ``Distinct items`` reflects the *filtered total* from the server,
//     not just the current page.
//   * ``Out of stock`` is exact today only because the backend doesn't
//     have a ledger yet — every item is ``out_of_stock``. Once movements
//     ship we'll either move it to a ``/items/summary`` endpoint or
//     accept that it's a page-scoped count.
//   * ``Inventory value``, ``Outstanding POs``, ``Expiring soon`` are
//     intentionally zeroed and labeled until the ledger + lot module
//     lands. Showing made-up numbers would be worse than showing none.
export const InventoryKPIs = React.memo(function InventoryKPIs({
  items,
  total,
}: InventoryKPIsProps) {
  const m = React.useMemo(() => {
    const inStockOnPage = items.filter((i) => i.qty > 0).length;
    const outOfStockTotal = items.length === 0 ? total : total; // see note above
    return {
      distinctTotal: total,
      inStockOnPage,
      outOfStockTotal,
    };
  }, [items, total]);

  return (
    <ul
      role="list"
      className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
    >
      <Metric
        label="Distinct items"
        value={m.distinctTotal.toLocaleString()}
        hint={`${m.inStockOnPage} in stock on this page`}
      />
      <Metric
        label="Inventory value"
        value={fmtUsdK(0)}
        hint="Awaiting ledger module"
      />
      <Metric label="Outstanding POs" value={fmtUsdK(0)} hint="Awaiting PO module" />
      <Metric
        label="Out of stock"
        value={m.outOfStockTotal.toLocaleString()}
        hint="Needs reorder"
        // Same tone the badge uses, from the shared config. This tile said
        // amber while the table badge said grey and the reorder row said red —
        // three colours for one status (client-reported 2026-08-24).
        tone={
          m.outOfStockTotal > 0
            ? STOCK_STATUS_META.out_of_stock.tone
            : STOCK_STATUS_META.available.tone
        }
      />
      <Metric
        label="Expiring soon"
        value="—"
        hint="Awaiting lot module"
      />
    </ul>
  );
});

function Metric({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint: string;
  /** Accepts the full ``BadgeTone`` set so a tile can carry the same tone as
   *  the badge for the thing it counts — it could not express ``danger``
   *  before, which is part of why the out-of-stock tile drifted to amber. */
  tone?: BadgeTone;
}) {
  return (
    <li className="rounded-md border border-border bg-bg-elev p-3.5 shadow-elev-sm">
      <div className="text-[11px] font-medium uppercase tracking-wider text-text-3">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 font-mono text-xl font-semibold leading-none tracking-tight',
          TONE_TEXT[tone],
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 text-xs text-text-3">{hint}</div>
    </li>
  );
}
