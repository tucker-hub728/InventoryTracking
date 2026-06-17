'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/empty-state';
import { YearPicker } from '@/components/forecast/year-picker';
import { cn, formatNumber } from '@/lib/utils';
import { materialsApi, type ProductMaterial } from '@/lib/api/products';
import { forecastApi } from '@/lib/api/forecast';
import { ApiError } from '@/lib/api/client';

type CoverageStatus = 'ok' | 'watch' | 'reorder' | 'critical';

const STATUS_META: Record<
  CoverageStatus,
  { label: string; tone: 'success' | 'warning' | 'danger'; bar: string }
> = {
  ok: { label: 'OK', tone: 'success', bar: 'bg-success' },
  watch: { label: 'Watch', tone: 'warning', bar: 'bg-warning' },
  reorder: { label: 'Reorder soon', tone: 'warning', bar: 'bg-warning' },
  critical: { label: 'Critical', tone: 'danger', bar: 'bg-danger' },
};

/**
 * Coverage status from on-hand stock vs the year's total demand. Thresholds are
 * deliberately simple + tunable: covered = OK; ≥67% = Watch; ≥10% = Reorder
 * soon; below that (or zero) = Critical.
 */
function statusOf(onHand: number, yearTotal: number): CoverageStatus {
  if (yearTotal <= 0 || onHand >= yearTotal) return 'ok';
  const coverage = onHand / yearTotal;
  if (onHand === 0 || coverage < 0.1) return 'critical';
  if (coverage < 0.67) return 'reorder';
  return 'watch';
}

interface Row {
  mat: ProductMaterial;
  perRun: number;
  yearTotal: number;
  onHand: number;
  deficit: number;
  coverage: number; // 0..1, clamped
  status: CoverageStatus;
}

/**
 * Product Forecast tab — turns this product's forecasted production runs for the
 * year into per-component material demand, and checks each component's on-hand
 * stock against the full-year total (per run × runs). Mirrors the inventory
 * item's Forecast Impact, but for every material in the product's BOM at once.
 */
export function ProductForecastTab({ productId }: { productId: string }) {
  const [year, setYear] = React.useState(() => new Date().getFullYear());
  const [materials, setMaterials] = React.useState<ProductMaterial[]>([]);
  const [runs, setRuns] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      materialsApi.list(productId, { signal: ctrl.signal }),
      forecastApi.list({ year, productId }, { signal: ctrl.signal }),
    ])
      .then(([mats, entries]) => {
        if (ctrl.signal.aborted) return;
        setMaterials(mats);
        setRuns(entries.reduce((sum, e) => sum + e.runs, 0));
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load forecast.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [productId, year]);

  const rows = React.useMemo<Row[]>(
    () =>
      materials.map((mat) => {
        const perRun = Number(mat.qty_per_run);
        // Coverage uses *available* stock (date-expired units excluded).
        const onHand = Number(mat.qty_available);
        const yearTotal = perRun * runs;
        const deficit = Math.max(0, yearTotal - onHand);
        const coverage = yearTotal > 0 ? Math.min(1, onHand / yearTotal) : 1;
        return { mat, perRun, yearTotal, onHand, deficit, coverage, status: statusOf(onHand, yearTotal) };
      }),
    [materials, runs],
  );

  const shortRows = rows.filter((r) => r.status !== 'ok');

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold">Component status — full year demand</h3>
        <p className="text-xs text-text-3">
          {formatNumber(runs)} production run{runs === 1 ? '' : 's'} forecast for {year}
        </p>
      </div>
      <YearPicker value={year} onChange={setYear} ariaLabel="Forecast year" />
    </div>
  );

  if (error) {
    return (
      <div className="p-4">
        <EmptyState title="Couldn't load forecast" hint={error} />
      </div>
    );
  }
  if (loading && materials.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-text-3" role="status">
        Loading forecast…
      </div>
    );
  }
  if (materials.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title="No materials yet"
          hint="Add materials to this product's bill of materials to see forecast coverage."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {header}

      {runs === 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-xs text-text-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-text-3" />
          <span>
            No production runs forecast for {year}. Plan runs for this product on the Forecast page
            to see component demand.
          </span>
        </div>
      ) : shortRows.length > 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2.5 text-xs text-danger">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            <strong>{shortRows.length}</strong> component{shortRows.length === 1 ? ' is' : 's are'}{' '}
            short for {year}&apos;s {formatNumber(runs)} run{runs === 1 ? '' : 's'}.
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2.5 text-xs text-success">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          <span>All components are covered for {year}&apos;s {formatNumber(runs)} forecast runs.</span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
              <th className="px-4 py-2 font-medium">Component</th>
              <th className="px-4 py-2 text-right font-medium">Per run</th>
              <th className="px-4 py-2 text-right font-medium">Year total</th>
              <th className="px-4 py-2 text-right font-medium">On hand</th>
              <th className="px-4 py-2 font-medium">Coverage</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const meta = STATUS_META[r.status];
              return (
                <tr key={r.mat.id} className="border-b border-border/60 hover:bg-surface">
                  <td className="px-4 py-2.5">
                    <div className="line-clamp-1 font-medium text-text" title={r.mat.item_name}>
                      {r.mat.item_name}
                    </div>
                    <Link
                      href={`/inventory/${r.mat.item_number}`}
                      className="font-mono text-[11px] text-accent hover:underline"
                    >
                      {r.mat.item_number}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono">{formatNumber(r.perRun)}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-semibold">
                    {formatNumber(r.yearTotal)}
                  </td>
                  <td
                    className={cn(
                      'px-4 py-2.5 text-right font-mono',
                      r.status === 'ok'
                        ? 'text-success'
                        : r.status === 'watch'
                          ? 'text-text'
                          : 'text-danger',
                    )}
                  >
                    {formatNumber(r.onHand)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-col gap-1">
                      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className={cn('h-full rounded-full', meta.bar)}
                          style={{ width: `${Math.round(r.coverage * 100)}%` }}
                        />
                      </div>
                      <span
                        className={cn(
                          'text-[11px]',
                          r.deficit === 0
                            ? 'text-success'
                            : r.status === 'critical'
                              ? 'text-danger'
                              : 'text-text-3',
                        )}
                      >
                        {r.deficit === 0
                          ? 'Covered ✓'
                          : r.status === 'critical'
                            ? `Need ${formatNumber(r.deficit)} — order now`
                            : `Need ${formatNumber(r.deficit)} more`}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={meta.tone} dot>
                      {meta.label}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
