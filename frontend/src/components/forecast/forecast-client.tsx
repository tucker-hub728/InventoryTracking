'use client';

import * as React from 'react';
import Link from 'next/link';
import { Save } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { usePermission } from '@/hooks/use-permission';
import { cn, formatNumber } from '@/lib/utils';
import { MONTH_LABELS } from '@/lib/forecast/types';
import { YearPicker } from './year-picker';
import {
  forecastApi,
  type ForecastChange,
  type ForecastEntry,
} from '@/lib/api/forecast';
import { itemsApi } from '@/lib/api/items';
import { isBuiltTier } from '@/lib/api/tiers';
import { customersApi, type Customer } from '@/lib/api/customers';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';

/**
 * A forecastable finished good. Under the unified catalogue a "product" is a
 * built item; ``sku`` maps to its item number and ``name`` to its description,
 * keeping the rest of this grid unchanged.
 */
interface Product {
  id: string;
  sku: string;
  name: string;
}

const ALL_PRODUCTS = 'all';
const ALL_CUSTOMERS = 'all';
const UNASSIGNED = 'none'; // customer-filter value + draft-key sentinel for "no customer"
const MAX_RUNS = 100_000;

/** Quarters as (label number, month indices). */
const QUARTERS: { n: number; months: [number, number, number] }[] = [
  { n: 1, months: [0, 1, 2] },
  { n: 2, months: [3, 4, 5] },
  { n: 3, months: [6, 7, 8] },
  { n: 4, months: [9, 10, 11] },
];

/** Pending edits, keyed by `year|customerKey|productId|month` → runs. */
type Drafts = Record<string, number>;

/** customerKey is the customer UUID, or "none" for a product-level cell. */
const custKeyOf = (customerId: string | null) => customerId ?? UNASSIGNED;
const draftKey = (year: number, customerKey: string, productId: string, month: number) =>
  `${year}|${customerKey}|${productId}|${month}`;

interface GridRow {
  product: Product;
  monthRuns: number[]; // length 12, draft overlaid on stored
  dirty: boolean[]; // length 12, true where a pending edit differs from store
}
interface GridGroup {
  customerId: string | null; // null = Unassigned
  customerName: string;
  rows: GridRow[];
}

/**
 * Forecast page — a spreadsheet-style grid mirroring the SOT workbook.
 *
 * Rows are grouped by customer (plus a top "Unassigned" group for product-level
 * forecasts), then by product; columns are the 12 months of the selected year +
 * Q1–Q4 + Total roll-ups. Entries are loaded from the API; month cells are
 * edited into a draft buffer (quarter/total preview live) and persisted only on
 * **Save**, which is an e-signed, audit-logged batch write.
 */
export function ForecastClient() {
  // Saving is a GxP-significant signed action → gate on `sign`.
  const canEdit = usePermission('inventory', 'sign');

  const [products, setProducts] = React.useState<Product[]>([]);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [entries, setEntries] = React.useState<ForecastEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const currentYear = React.useMemo(() => new Date().getFullYear(), []);
  const [year, setYear] = React.useState(currentYear);
  const [productId, setProductId] = React.useState<string>(ALL_PRODUCTS);
  const [customerId, setCustomerId] = React.useState<string>(ALL_CUSTOMERS);

  const [drafts, setDrafts] = React.useState<Drafts>({});
  const [signing, setSigning] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // ── Reference data (products + customers) — once ────────────────────────
  const loadRefs = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const [itemsResp, custs] = await Promise.all([
        itemsApi.list({ limit: 200 }, { signal }),
        customersApi.list({}, { signal }),
      ]);
      if (signal?.aborted) return;
      // Forecastable products = built (finished-good) items.
      setProducts(
        itemsResp.items
          .filter((i) => isBuiltTier(i.tier_type))
          .map((i) => ({ id: i.id, sku: i.item_number, name: i.description })),
      );
      setCustomers(custs);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load forecast data.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void loadRefs(ctrl.signal);
    return () => ctrl.abort();
  }, [loadRefs]);

  // ── Entries — reloaded when the year changes (and after a save) ─────────
  const loadEntries = React.useCallback(
    async (signal?: AbortSignal) => {
      try {
        const rows = await forecastApi.list({ year }, { signal });
        if (signal?.aborted) return;
        setEntries(rows);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        // Non-fatal: keep the grid usable, surface a toast.
        toast.error('Couldn’t load forecast figures', {
          description: err instanceof ApiError ? err.message : 'Please retry.',
        });
      }
    },
    [year],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void loadEntries(ctrl.signal);
    return () => ctrl.abort();
  }, [loadEntries]);

  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // Stored runs keyed by `customerKey|productId|month` (entries are year-scoped).
  const runsByKey = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const e of entries) {
      map.set(`${custKeyOf(e.customerId)}|${e.productId}|${e.month}`, e.runs);
    }
    return map;
  }, [entries]);

  // Build a group's product rows (draft overlaid on stored), product-filtered.
  const buildRows = React.useCallback(
    (groupCustomerId: string | null, candidateProductIds: Iterable<string>): GridRow[] => {
      const customerKey = custKeyOf(groupCustomerId);
      const ids = new Set(candidateProductIds);
      return [...ids]
        .filter((id) => (productId === ALL_PRODUCTS ? true : id === productId))
        .map((id) => productById.get(id))
        .filter((p): p is Product => Boolean(p))
        .sort((a, b) => a.sku.localeCompare(b.sku))
        .map((product) => {
          const monthRuns: number[] = [];
          const dirty: boolean[] = [];
          for (let m = 0; m < 12; m += 1) {
            const dk = draftKey(year, customerKey, product.id, m);
            const stored = runsByKey.get(`${customerKey}|${product.id}|${m}`) ?? 0;
            const hasDraft = dk in drafts;
            monthRuns.push(hasDraft ? drafts[dk]! : stored);
            dirty.push(hasDraft);
          }
          return { product, monthRuns, dirty };
        });
    },
    [productId, productById, year, runsByKey, drafts],
  );

  // Groups: Unassigned (all products) first, then one per customer (linked
  // products ∪ products that already have entries for that customer).
  const groups = React.useMemo<GridGroup[]>(() => {
    const result: GridGroup[] = [];

    const showUnassigned = customerId === ALL_CUSTOMERS || customerId === UNASSIGNED;
    if (showUnassigned) {
      const rows = buildRows(null, products.map((p) => p.id));
      if (rows.length > 0) {
        result.push({ customerId: null, customerName: 'Unassigned (no customer)', rows });
      }
    }

    if (customerId !== UNASSIGNED) {
      for (const customer of customers) {
        if (customerId !== ALL_CUSTOMERS && customerId !== customer.id) continue;
        const ids = new Set<string>();
        for (const ref of customer.items) ids.add(ref.id);
        for (const e of entries) {
          if (e.customerId === customer.id) ids.add(e.productId);
        }
        const rows = buildRows(customer.id, ids);
        if (rows.length > 0) {
          result.push({ customerId: customer.id, customerName: customer.name, rows });
        }
      }
    }

    return result;
  }, [products, customers, entries, customerId, buildRows]);

  // Record an edit into the draft buffer (prunes back to clean if it matches).
  const setDraft = React.useCallback(
    (groupCustomerId: string | null, pid: string, month: number, runs: number) => {
      const customerKey = custKeyOf(groupCustomerId);
      const dk = draftKey(year, customerKey, pid, month);
      const stored = runsByKey.get(`${customerKey}|${pid}|${month}`) ?? 0;
      setDrafts((prev) => {
        const next = { ...prev };
        if (runs === stored) delete next[dk];
        else next[dk] = runs;
        return next;
      });
    },
    [year, runsByKey],
  );

  const dirtyCount = Object.keys(drafts).length;

  const handleDiscard = () => setDrafts({});

  // Signed save: turn the draft buffer into a batch of changes and PUT them
  // with the e-signature evidence id.
  const handleSignedSave = async (evidence: ReauthResponse) => {
    const changes: ForecastChange[] = Object.entries(drafts).map(([key, runs]) => {
      const [y, customerKey, pid, m] = key.split('|');
      return {
        productId: pid!,
        customerId: customerKey === UNASSIGNED ? null : customerKey!,
        year: Number(y),
        month: Number(m), // 0-based; the API client maps to 1-12
        runs,
      };
    });
    if (changes.length === 0) return;

    setSaving(true);
    try {
      const result = await forecastApi.save({ changes, evidenceId: evidence.evidence_id });
      setDrafts({});
      await loadEntries();
      toast.success('Forecast saved', {
        description: `${result.upserted} updated · ${result.deleted} cleared`,
      });
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === 'reauth_evidence_expired' || err.code === 'reauth_evidence_replayed')
      ) {
        toast.error('Signature expired or already used', {
          description: 'Please sign again to save.',
        });
      } else {
        toast.error('Save failed', {
          description: err instanceof ApiError ? err.message : 'Please try again.',
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const COL_COUNT = 1 + 12 + QUARTERS.length + 1; // product + months + quarters + total

  return (
    <>
      <PageHeader
        title="Forecast"
        subtitle="Production planning and demand projection"
        actions={
          canEdit ? (
            <>
              {dirtyCount > 0 && (
                <span className="text-xs font-medium text-warning">
                  {dirtyCount} unsaved change{dirtyCount === 1 ? '' : 's'}
                </span>
              )}
              <Button variant="ghost" onClick={handleDiscard} disabled={dirtyCount === 0 || saving}>
                Discard
              </Button>
              <Button
                variant="primary"
                onClick={() => setSigning(true)}
                disabled={dirtyCount === 0 || saving}
              >
                <Save size={14} /> {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="space-y-5 px-6 py-5 sm:px-8">
        {/* ── Filters ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-end gap-3">
          <Filter label="Product">
            <Select value={productId} onValueChange={setProductId} disabled={products.length === 0}>
              <SelectTrigger className="min-w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value={ALL_PRODUCTS}>All products</SelectItem>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="font-mono text-xs">{p.sku}</span>
                    <span className="ml-2 text-text-2">{p.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Filter>

          <Filter label="Customer">
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger className="min-w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value={ALL_CUSTOMERS}>All customers</SelectItem>
                <SelectItem value={UNASSIGNED}>Unassigned (no customer)</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Filter>

          <Filter label="Year">
            <YearPicker value={year} onChange={setYear} ariaLabel="Forecast year" />
          </Filter>
        </div>

        {/* ── Grid ────────────────────────────────────────────────────── */}
        {loadError ? (
          <Card>
            <EmptyState
              title="Couldn't load forecast"
              hint={loadError}
              action={<Button onClick={() => void loadRefs()}>Retry</Button>}
            />
          </Card>
        ) : loading && products.length === 0 ? (
          <Card>
            <div className="py-12 text-center text-sm text-text-3" role="status">
              Loading forecast…
            </div>
          </Card>
        ) : groups.length === 0 ? (
          <Card>
            <EmptyState
              title={
                products.length === 0 ? 'No products yet' : 'Nothing to forecast here'
              }
              hint={
                products.length === 0
                  ? 'Create a product first, then plan its production runs here.'
                  : 'Use the “Unassigned” group for product-level forecasts, or link products to customers on the Customers page.'
              }
            />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface text-[11px] uppercase tracking-wider text-text-3">
                    <th className="sticky left-0 z-10 min-w-[200px] bg-surface px-3 py-2.5 text-left font-medium">
                      Customer / Product
                    </th>
                    {MONTH_LABELS.map((label) => (
                      <th key={label} className="min-w-[52px] px-2 py-2.5 text-right font-medium">
                        {label}-{String(year).slice(2)}
                      </th>
                    ))}
                    {QUARTERS.map((q) => (
                      <th
                        key={q.n}
                        className="min-w-[64px] border-l border-border bg-surface-2 px-2 py-2.5 text-right font-medium"
                      >
                        Q{q.n} {year}
                      </th>
                    ))}
                    <th className="min-w-[64px] border-l border-border px-2 py-2.5 text-right font-semibold text-text-2">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <React.Fragment key={group.customerId ?? UNASSIGNED}>
                      <tr className="border-b border-border bg-surface/60">
                        <td
                          colSpan={COL_COUNT}
                          className="sticky left-0 z-10 bg-surface/60 px-3 py-1.5 text-xs font-semibold text-text"
                        >
                          {group.customerName}
                        </td>
                      </tr>
                      {group.rows.map((row) => (
                        <ProductRow
                          key={`${group.customerId ?? UNASSIGNED}:${row.product.id}`}
                          product={row.product}
                          monthRuns={row.monthRuns}
                          dirty={row.dirty}
                          editable={canEdit}
                          onSet={(month, runs) => setDraft(group.customerId, row.product.id, month, runs)}
                        />
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {!loading && groups.length > 0 && (
          <p className="text-xs text-text-3">
            {canEdit
              ? 'Tip: click any month cell and type the planned production runs, then Save (you’ll sign to confirm). Quarter and total columns preview as you type; unsaved cells are highlighted.'
              : 'Quarter and total columns are rolled up from the monthly run counts.'}
          </p>
        )}
      </div>

      <PasswordReauthDialog
        open={signing}
        onOpenChange={setSigning}
        action="forecast.save"
        meaning="I attest these forecast figures are accurate."
        title="Sign to save forecast"
        submitLabel="Sign & save"
        onConfirmed={(evidence) => void handleSignedSave(evidence)}
      />
    </>
  );
}

// ── Row ────────────────────────────────────────────────────────────────────

interface ProductRowProps {
  product: Product;
  monthRuns: number[];
  dirty: boolean[];
  editable: boolean;
  onSet: (month: number, runs: number) => void;
}

function ProductRow({ product, monthRuns, dirty, editable, onSet }: ProductRowProps) {
  const quarterTotals = QUARTERS.map((q) => q.months.reduce((s, m) => s + (monthRuns[m] ?? 0), 0));
  const yearTotal = monthRuns.reduce((s, n) => s + n, 0);

  return (
    <tr className="border-b border-border/60 hover:bg-surface/40">
      <td className="sticky left-0 z-10 bg-bg-elev px-3 py-1.5">
        <Link
          href={`/inventory/${product.id}/ledger`}
          className="font-mono text-xs text-accent hover:underline"
        >
          {product.sku}
        </Link>
        <span className="ml-2 text-text-2">{product.name}</span>
      </td>
      {monthRuns.map((runs, m) => (
        <RunCell
          key={m}
          value={runs}
          dirty={dirty[m] ?? false}
          editable={editable}
          label={`${product.sku} ${MONTH_LABELS[m]} runs`}
          onCommit={(n) => onSet(m, n)}
        />
      ))}
      {QUARTERS.map((q, i) => (
        <td
          key={q.n}
          className="border-l border-border bg-surface-2/60 px-2 py-1.5 text-right font-mono text-xs text-text-2"
        >
          {quarterTotals[i] ? formatNumber(quarterTotals[i]!) : ''}
        </td>
      ))}
      <td className="border-l border-border px-2 py-1.5 text-right font-mono text-xs font-semibold">
        {yearTotal ? formatNumber(yearTotal) : ''}
      </td>
    </tr>
  );
}

// ── Editable cell ────────────────────────────────────────────────────────────

interface RunCellProps {
  value: number;
  dirty: boolean;
  editable: boolean;
  label: string;
  onCommit: (runs: number) => void;
}

function RunCell({ value, dirty, editable, label, onCommit }: RunCellProps) {
  const [draft, setDraft] = React.useState(value ? String(value) : '');

  React.useEffect(() => {
    setDraft(value ? String(value) : '');
  }, [value]);

  if (!editable) {
    return (
      <td className="px-2 py-1.5 text-right font-mono text-sm tabular-nums">
        {value ? formatNumber(value) : ''}
      </td>
    );
  }

  const commit = () => {
    const parsed = Math.max(0, Math.min(MAX_RUNS, Math.floor(Number(draft) || 0)));
    setDraft(parsed ? String(parsed) : '');
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <td className={cn('p-0', dirty && 'bg-warning-soft')}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(value ? String(value) : '');
            e.currentTarget.blur();
          }
        }}
        inputMode="numeric"
        aria-label={label}
        className={cn(
          'h-9 w-full bg-transparent px-2 text-right font-mono text-sm tabular-nums outline-none',
          'focus:bg-accent-soft focus:ring-1 focus:ring-inset focus:ring-accent',
          !dirty && 'hover:bg-surface',
          dirty && 'font-semibold text-warning',
        )}
        placeholder="·"
      />
    </td>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-text-3">{label}</span>
      {children}
    </label>
  );
}
