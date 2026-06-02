'use client';

import * as React from 'react';
import { Info } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { uomsApi, type UnitOfMeasure } from '@/lib/api/uoms';
import { ApiError } from '@/lib/api/client';

export function UomsPageClient() {
  const [uoms, setUoms] = React.useState<UnitOfMeasure[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      setUoms(await uomsApi.list({ signal }));
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load units.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Units of measure"
        subtitle="System-managed lookup. Inventory items reference units by code — new units land via database migration only."
      />

      <div className="px-6 py-5 sm:px-8 space-y-4">
        <div className="flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-2">
          <Info size={14} className="mt-0.5 shrink-0 text-text-3" aria-hidden />
          <span>
            This list is read-only. Items FK to <code className="font-mono">code</code>;
            adding a unit ad-hoc would break referential design. To add a new unit,
            ask engineering to write a migration.
          </span>
        </div>

        <Card className="p-4">
          {loadError ? (
            <EmptyState
              title="Couldn't load units"
              hint={loadError}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          ) : loading ? (
            <div className="py-10 text-center text-sm text-text-3" role="status">
              Loading units…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                    <th className="px-3 py-2 font-medium">Code</th>
                    <th className="px-3 py-2 font-medium">Label</th>
                    <th className="px-3 py-2 font-medium">Kind</th>
                  </tr>
                </thead>
                <tbody>
                  {uoms.map((u) => (
                    <tr
                      key={u.code}
                      className="border-b border-border/60 transition-colors hover:bg-surface"
                    >
                      <td className="px-3 py-2.5 font-mono text-text">{u.code}</td>
                      <td className="px-3 py-2.5">{u.label}</td>
                      <td className="px-3 py-2.5 text-text-3">
                        {u.is_discrete ? 'Discrete (whole units)' : 'Continuous (decimals OK)'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
