'use client';

import * as React from 'react';
import { Plus, Search } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { EmptyState } from '@/components/shared/empty-state';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermission } from '@/hooks/use-permission';
import {
  lotsApi,
  LOT_STATUS_OPTIONS,
  type Lot,
  type LotStatus,
} from '@/lib/api/lots';
import { ApiError } from '@/lib/api/client';

import { LotsTable } from './lots-table';
import { LotCreateDialog } from './lot-create-dialog';

const STATUS_ALL = '__all__';

export function LotsPageClient() {
  const canCreate = usePermission('inventory', 'create');

  const [lots, setLots] = React.useState<Lot[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<LotStatus | typeof STATUS_ALL>(
    STATUS_ALL,
  );
  const [creating, setCreating] = React.useState(false);

  const debounced = useDebouncedValue(query, 150);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const all = await lotsApi.list({
          status: statusFilter === STATUS_ALL ? undefined : statusFilter,
          limit: 500,
          signal,
        });
        setLots(all);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load lots.');
      } finally {
        setLoading(false);
      }
    },
    [statusFilter],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const filtered = React.useMemo(() => {
    const q = debounced.trim().toLowerCase();
    if (!q) return lots;
    return lots.filter(
      (l) =>
        l.lot_number.toLowerCase().includes(q) ||
        (l.item_number ?? '').toLowerCase().includes(q) ||
        (l.item_description ?? '').toLowerCase().includes(q) ||
        (l.vendor_name ?? '').toLowerCase().includes(q),
    );
  }, [lots, debounced]);

  const handleCreated = (created: Lot) => {
    setLots((prev) => [created, ...prev]);
    toast.success('Lot added', {
      description: `${created.item_number ?? ''} · ${created.lot_number}`,
    });
  };

  return (
    <>
      <PageHeader
        title="Lots"
        subtitle="Manufacturer batches per item — used for traceability and expiry tracking."
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> Add lot
            </Button>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="p-4">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[260px]">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by lot #, item, or vendor"
                className="pl-9"
                aria-label="Search lots"
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as LotStatus | typeof STATUS_ALL)}
            >
              <SelectTrigger className="w-[180px]" aria-label="Filter by status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={STATUS_ALL}>All statuses</SelectItem>
                {LOT_STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.code} value={o.code}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="text-xs text-text-3">
              {loading ? 'Loading…' : `${filtered.length} of ${lots.length}`}
            </div>
          </div>

          {loadError ? (
            <EmptyState
              title="Couldn't load lots"
              hint={loadError}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          ) : !loading && lots.length === 0 ? (
            <EmptyState
              title="No lots yet"
              hint="Lots are usually created at receipt time, but you can add one here for catalog setup."
              action={
                canCreate ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus size={14} /> Add lot
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <LotsTable lots={filtered} loading={loading} />
          )}
        </Card>
      </div>

      <LotCreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={handleCreated}
      />
    </>
  );
}
