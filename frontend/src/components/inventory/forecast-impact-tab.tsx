'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatNumber } from '@/lib/utils';
import {
  MONTH_LABELS,
  PERIODS,
  periodMonths,
  type PeriodKey,
} from '@/lib/forecast/types';
import { forecastApi, type ForecastEntry } from '@/lib/api/forecast';
import { productsApi, type Product } from '@/lib/api/products';
import { ApiError } from '@/lib/api/client';

interface Props {
  /** Inventory item UUID. */
  itemId: string;
  /** Current quantity on hand — the starting point availability depletes from. */
  onHand: number;
}

/**
 * Forecast Impact tab — projects demand for this inventory item against its
 * availability over the selected period.
 *
 * Demand = Σ over every product whose BOM uses this item of
 * (the item's qty-per-run in that product × the product's forecasted runs that
 * month, across all customers). Availability starts at the current on-hand
 * quantity and depletes cumulatively as demand accrues across the period,
 * surfacing the month a projected shortage begins. Forecast runs come from the
 * forecast API.
 */
export function ForecastImpactTab({ itemId, onHand }: Props) {
  const year = React.useMemo(() => new Date().getFullYear(), []);

  const [usingProducts, setUsingProducts] = React.useState<Product[]>([]);
  const [entries, setEntries] = React.useState<ForecastEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [period, setPeriod] = React.useState<PeriodKey>('full');

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      productsApi.usingItem(itemId, { signal: ctrl.signal }),
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

  const months = periodMonths(period);

  // Monthly demand for this item = Σ products(qty_per_run × runs that month,
  // summed across all customers).
  const monthlyDemand = React.useMemo(() => {
    return months.map((m) =>
      usingProducts.reduce((sum, p) => {
        const perRun = Number(p.qty_per_run ?? 0);
        const runs = entries
          .filter((e) => e.productId === p.id && e.month === m)
          .reduce((r, e) => r + e.runs, 0);
        return sum + perRun * runs;
      }, 0),
    );
  }, [months, usingProducts, entries]);

  // Cumulative demand + depleting availability across the displayed period.
  const { chartData, totalDemand, shortfallMonthIdx, maxDeficit } = React.useMemo(() => {
    let cumulative = 0;
    let firstShort = -1;
    let worst = 0;
    const data = months.map((m, i) => {
      cumulative += monthlyDemand[i] ?? 0;
      const available = Math.max(0, onHand - cumulative);
      if (cumulative > onHand && firstShort === -1) firstShort = m;
      worst = Math.max(worst, cumulative - onHand);
      return {
        month: MONTH_LABELS[m]!,
        demand: cumulative,
        available,
      };
    });
    return {
      chartData: data,
      totalDemand: cumulative,
      shortfallMonthIdx: firstShort,
      maxDeficit: Math.max(0, worst),
    };
  }, [months, monthlyDemand, onHand]);

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? 'Full year';

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
        title="Not used in any product"
        hint="This item isn't part of any product's bill of materials, so it has no forecasted demand."
      />
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Projected demand vs. availability</h3>
          <p className="text-xs text-text-3">
            Across {usingProducts.length} product{usingProducts.length === 1 ? '' : 's'} · {year}
          </p>
        </div>
        <Select value={period} onValueChange={(v) => setPeriod(v as PeriodKey)}>
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {totalDemand === 0 ? (
        <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-border text-sm text-text-3">
          No forecasted demand for this item in {periodLabel.toLowerCase()} {year}.
        </div>
      ) : (
        <>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="fc-demand" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--danger)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--danger)" stopOpacity={0.03} />
                  </linearGradient>
                  <linearGradient id="fc-available" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--success)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--success)" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 12, fill: 'var(--text-3)' }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--border)' }}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 12, fill: 'var(--text-3)' }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-elev)',
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area
                  type="monotone"
                  name="Demand"
                  dataKey="demand"
                  stroke="var(--danger)"
                  strokeDasharray="5 4"
                  fill="url(#fc-demand)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  name="Available"
                  dataKey="available"
                  stroke="var(--success)"
                  fill="url(#fc-available)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {shortfallMonthIdx >= 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2.5 text-xs text-danger">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                Projected shortage starting {MONTH_LABELS[shortfallMonthIdx]} {year} — demand
                exceeds available stock by up to <strong>{formatNumber(maxDeficit)}</strong> units.
              </span>
            </div>
          ) : (
            <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2.5 text-xs text-success">
              On-hand stock of <strong>{formatNumber(onHand)}</strong> covers projected demand of{' '}
              <strong>{formatNumber(totalDemand)}</strong> for {periodLabel.toLowerCase()} {year}.
            </div>
          )}
        </>
      )}
    </div>
  );
}
