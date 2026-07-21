'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { YearPicker } from '@/components/forecast/year-picker';
import { formatNumber } from '@/lib/utils';
import { forecastApi, type ForecastEntry } from '@/lib/api/forecast';
import { bomApi, type ApiWhereUsed } from '@/lib/api/bom';
import { ApiError } from '@/lib/api/client';

interface Props {
  /** Inventory item UUID. */
  itemId: string;
  /** Current quantity on hand. */
  onHand: number;
}

interface DemandRow {
  parent: ApiWhereUsed;
  perRun: number; // qty of this item consumed per run of that parent
  runs: number; // forecasted runs for the parent this year
  needed: number; // perRun × runs
}

/**
 * Forecast Impact tab — a requirements breakdown for one inventory item.
 *
 * For the full year it lists every product whose BOM uses this item with
 * ``per run × forecasted runs = needed``, totals the demand, and compares it to
 * the quantity on hand (covered, or short by N). Forecast runs come from the
 * forecast API; the per-run quantity comes from each product's BOM.
 */
export function ForecastImpactTab({ itemId, onHand }: Props) {
  const [year, setYear] = React.useState(() => new Date().getFullYear());

  const [usingProducts, setUsingProducts] = React.useState<ApiWhereUsed[]>([]);
  const [entries, setEntries] = React.useState<ForecastEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      bomApi.whereUsed(itemId, { signal: ctrl.signal }),
      forecastApi.list({ year }, { signal: ctrl.signal }),
    ])
      .then(([using, ents]) => {
        if (ctrl.signal.aborted) return;
        setUsingProducts(using);
        setEntries(ents);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load forecast impact.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [itemId, year]);

  // One row per product that has forecasted runs for this item this year.
  const rows = React.useMemo<DemandRow[]>(() => {
    return usingProducts
      .map((parent) => {
        const runs = entries
          .filter((e) => e.productId === parent.parent_item_id)
          .reduce((sum, e) => sum + e.runs, 0);
        const perRun = Number(parent.qty_per_unit ?? 0);
        return { parent, perRun, runs, needed: perRun * runs };
      })
      .filter((r) => r.runs > 0)
      .sort((a, b) => b.needed - a.needed);
  }, [usingProducts, entries]);

  const totalNeeded = rows.reduce((sum, r) => sum + r.needed, 0);
  const remaining = onHand - totalNeeded;
  const short = remaining < 0;

  if (error) {
    return <EmptyState title="Couldn't load forecast impact" hint={error} />;
  }
  if (loading && usingProducts.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-text-3" role="status">
        Loading forecast impact…
      </div>
    );
  }
  if (usingProducts.length === 0) {
    return (
      <EmptyState
        title="Not used in any Product"
        hint="This item isn't part of any Product's bill of materials, so it has no forecasted demand."
      />
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Projected demand for this item</h3>
          <p className="text-xs text-text-3">
            Production runs planned across the products that consume it.
          </p>
        </div>
        <YearPicker value={year} onChange={setYear} ariaLabel="Forecast year" />
      </div>

      {rows.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border text-sm text-text-3">
          No production runs forecast for {year}.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface text-left text-[11px] uppercase tracking-wider text-text-3">
                <th className="px-4 py-2.5 font-medium">Used in (Product)</th>
                <th className="px-4 py-2.5 text-right font-medium">Per run</th>
                <th className="px-4 py-2.5 text-right font-medium">× Runs</th>
                <th className="px-4 py-2.5 text-right font-medium">= Needed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ parent, perRun, runs, needed }) => (
                <tr key={parent.parent_item_id} className="border-b border-border/60">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/inventory/${parent.parent_item_id}/ledger`}
                      className="font-mono text-xs text-accent hover:underline"
                    >
                      {parent.parent_item_number}
                    </Link>
                    <span className="ml-2 text-text-2">{parent.parent_description}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono">{formatNumber(perRun)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-accent">
                    × {formatNumber(runs)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono font-semibold">
                    {formatNumber(needed)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-b border-border bg-surface/60">
                <td colSpan={3} className="px-4 py-2.5 text-right text-text-2">
                  Total needed
                </td>
                <td className="px-4 py-2.5 text-right font-mono font-semibold">
                  {formatNumber(totalNeeded)}
                </td>
              </tr>
              <tr className="border-b border-border/60">
                <td colSpan={3} className="px-4 py-2 text-right text-text-2">
                  Available (on hand)
                </td>
                <td className="px-4 py-2 text-right font-mono">{formatNumber(onHand)}</td>
              </tr>
              <tr className={short ? 'bg-danger/5' : 'bg-success/5'}>
                <td colSpan={3} className="px-4 py-2.5 text-right font-medium">
                  {short ? 'Short by' : 'Remaining'}
                </td>
                <td
                  className={`px-4 py-2.5 text-right font-mono font-semibold ${
                    short ? 'text-danger' : 'text-success'
                  }`}
                >
                  {formatNumber(Math.abs(remaining))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {rows.length > 0 &&
        (short ? (
          <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2.5 text-xs text-danger">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              Forecast demand of <strong>{formatNumber(totalNeeded)}</strong> for {year} exceeds the{' '}
              {formatNumber(onHand)} on hand — short by{' '}
              <strong>{formatNumber(Math.abs(remaining))}</strong>. Reorder before these runs.
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2.5 text-xs text-success">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            <span>
              On-hand stock of <strong>{formatNumber(onHand)}</strong> covers forecast demand of{' '}
              <strong>{formatNumber(totalNeeded)}</strong> for {year}.
            </span>
          </div>
        ))}
    </div>
  );
}
