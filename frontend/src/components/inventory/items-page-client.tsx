'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search, Boxes, Download, FlaskConical, Layers } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import { itemsApi, type ApiItem } from '@/lib/api/items';
import { locationsApi, type ApiLocation } from '@/lib/api/locations';
import { toNum } from '@/lib/api/helpers';
import { NewItemDialog } from './new-item-dialog';
import { ReceiveMaterialDialog } from './receive-material-dialog';

type ConsumableFilter = 'all' | 'consumable' | 'non-consumable';

const CHIPS: { id: ConsumableFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'consumable', label: 'Consumables' },
  { id: 'non-consumable', label: 'Non-consumables' },
];

export function ItemsPageClient() {
  const router = useRouter();
  const canCreate = usePermission('items', 'create');
  const canTransact = usePermission('transactions', 'create');

  const [rawSearch, setRawSearch] = React.useState('');
  const search = useDebouncedValue(rawSearch, 250);
  const [chip, setChip] = React.useState<ConsumableFilter>('all');

  const [items, setItems] = React.useState<ApiItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [receiveOpen, setReceiveOpen] = React.useState(false);
  const [locations, setLocations] = React.useState<ApiLocation[]>([]);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const rows = await itemsApi.list(
          { tier: 'CR', active: true, search: search.trim() || undefined },
          { signal },
        );
        setItems(rows);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load raw materials.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [search],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Active locations for the receive dialog's location picker.
  React.useEffect(() => {
    const ctrl = new AbortController();
    locationsApi
      .list({ active: true }, { signal: ctrl.signal })
      .then(setLocations)
      .catch(() => {
        /* non-fatal */
      });
    return () => ctrl.abort();
  }, []);

  // Stats reflect the full (search-scoped) CR set, independent of the chip.
  const stats = React.useMemo(() => {
    const onHand = items.reduce((sum, i) => sum + toNum(i.on_hand), 0);
    const consumables = items.filter((i) => i.is_consumable).length;
    return { count: items.length, onHand, consumables };
  }, [items]);

  const visible = React.useMemo(() => {
    if (chip === 'consumable') return items.filter((i) => i.is_consumable);
    if (chip === 'non-consumable') return items.filter((i) => !i.is_consumable);
    return items;
  }, [items, chip]);

  const handleCreated = (created: ApiItem) => {
    toast.success(`Created ${created.item_code}`);
    setCreateOpen(false);
    void load();
  };

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Raw Material Inventory (CR)"
        subtitle="Off-the-shelf raw materials purchased externally."
        actions={
          canTransact || canCreate ? (
            <div className="flex items-center gap-2">
              {canTransact && (
                <Button variant="secondary" onClick={() => setReceiveOpen(true)}>
                  <Download size={15} /> Receive Material
                </Button>
              )}
              {canCreate && (
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  <Plus size={15} /> New Raw Material
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

      <div className="grid gap-6 px-6 py-5 sm:px-8">
        {/* Stat cards */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard icon={FlaskConical} label="CR items" value={String(stats.count)} hint="Raw material SKUs" />
          <StatCard
            icon={Boxes}
            label="On-hand units"
            value={stats.onHand.toLocaleString()}
            hint="Across all locations"
          />
          <StatCard
            icon={Layers}
            label="Consumables"
            value={String(stats.consumables)}
            hint="Blind-consumed"
          />
        </section>

        {/* Search + chips */}
        <section className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full sm:max-w-xs">
            <Input
              icon={Search}
              value={rawSearch}
              onChange={(e) => setRawSearch(e.target.value)}
              placeholder="Search SKU or name…"
              aria-label="Search raw materials"
            />
          </div>
          <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-bg-elev p-1">
            {CHIPS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setChip(c.id)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  chip === c.id
                    ? 'bg-surface-2 font-medium text-text'
                    : 'text-text-2 hover:text-text',
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        </section>

        {/* Table */}
        <div className="overflow-hidden rounded-lg border border-border bg-bg-elev">
          {error ? (
            <EmptyState title="Couldn't load raw materials" hint={error} />
          ) : loading ? (
            <div className="px-5 py-16 text-center text-sm text-text-3">Loading…</div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="No raw materials"
              hint={search ? 'Try a different search.' : 'Create your first raw material.'}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">On-hand</TableHead>
                  <TableHead className="text-right">Locations</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((item) => (
                  <TableRow
                    key={item.id}
                    interactive
                    onClick={() => router.push(`/inventory/cr/${item.id}`)}
                  >
                    <TableCell className="font-mono text-xs">{item.item_code}</TableCell>
                    <TableCell className="max-w-[24rem]">
                      <div className="flex items-center gap-2">
                        <span className="truncate">{item.item_name}</span>
                        {item.is_consumable && <Badge tone="accent">Consumable</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {toNum(item.on_hand).toLocaleString()}{' '}
                      <span className="text-text-3">{item.unit_of_measure}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{item.location_count}</TableCell>
                    <TableCell className="text-right text-text-3">
                      {formatDate(item.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      <NewItemDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
      <ReceiveMaterialDialog
        open={receiveOpen}
        onOpenChange={setReceiveOpen}
        items={items}
        locations={locations}
        onCreated={() => {
          setReceiveOpen(false);
          void load();
        }}
      />
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-elev px-4 py-3.5">
      <div className="flex items-start justify-between">
        <div className="text-[11px] uppercase tracking-wider text-text-3">{label}</div>
        <Icon size={16} className="text-text-3" />
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-text-3">{hint}</div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
