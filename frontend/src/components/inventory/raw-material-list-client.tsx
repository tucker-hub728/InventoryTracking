'use client';

import * as React from 'react';
import Link from 'next/link';
import { Plus, Search } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import { itemsApi } from '@/lib/api/items';
import { categoriesApi, type ApiCategory } from '@/lib/api/categories';
import { apiItemToInventoryItem } from '@/lib/api/items-adapter';
import type { InventoryItem } from '@/types/inventory';

import { NewItemDialog } from './new-item-dialog';

/** Locate the raw-material category by its ``CR`` prefix (falling back to the
 *  seeded purchased tier if prefixes ever drift). */
function findRawMaterialCategory(cats: ApiCategory[]): ApiCategory | null {
  return (
    cats.find((c) => c.prefix?.toUpperCase() === 'CR') ??
    cats.find((c) => c.kind === 'purchased' && c.is_seeded) ??
    null
  );
}

export function RawMaterialListClient() {
  const canCreate = usePermission('inventory', 'create');

  const [category, setCategory] = React.useState<ApiCategory | null>(null);
  const [rows, setRows] = React.useState<InventoryItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  // Search box (debounced into the fetch below).
  const [queryInput, setQueryInput] = React.useState('');
  const [query, setQuery] = React.useState('');
  React.useEffect(() => {
    const t = setTimeout(() => setQuery(queryInput.trim()), 250);
    return () => clearTimeout(t);
  }, [queryInput]);

  // Resolve the CR category once.
  React.useEffect(() => {
    const ctrl = new AbortController();
    categoriesApi
      .list({ signal: ctrl.signal })
      .then((cats) => setCategory(findRawMaterialCategory(cats)))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load categories.',
        );
        setLoading(false);
      });
    return () => ctrl.abort();
  }, []);

  const fetchRows = React.useCallback(
    async (signal?: AbortSignal) => {
      if (!category) return;
      setLoading(true);
      setLoadError(null);
      try {
        const res = await itemsApi.list(
          {
            category_id: category.id,
            q: query || undefined,
            sort: 'item_number',
            direction: 'asc',
            limit: 200,
          },
          { signal },
        );
        setRows(res.items.map(apiItemToInventoryItem));
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load raw materials.',
        );
      } finally {
        setLoading(false);
      }
    },
    [category, query],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void fetchRows(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchRows]);

  return (
    <>
      <PageHeader
        title="Raw Materials"
        crumbs={[{ label: 'Inventory' }, { label: 'Raw Materials' }]}
        subtitle={
          loading
            ? 'Loading raw materials…'
            : `${rows.length.toLocaleString()} raw material${rows.length === 1 ? '' : 's'}`
        }
        actions={
          canCreate ? (
            <Button
              variant="primary"
              onClick={() => setCreating(true)}
              disabled={!category}
            >
              <Plus size={14} /> New Raw Material
            </Button>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <div className="mb-4 max-w-xs">
          <Input
            icon={Search}
            placeholder="Search SKU or name…"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            aria-label="Search raw materials"
          />
        </div>

        <Card className="overflow-hidden">
          {loadError ? (
            <EmptyState
              title="Couldn't load raw materials"
              hint={loadError}
              action={<Button onClick={() => void fetchRows()}>Retry</Button>}
            />
          ) : !loading && rows.length === 0 ? (
            <EmptyState
              title={query ? 'No raw materials match' : 'No raw materials yet'}
              hint={
                query
                  ? 'Try a different search term.'
                  : canCreate
                    ? 'Create your first raw material to get started.'
                    : 'Raw materials will appear here once added.'
              }
              action={
                !query && canCreate ? (
                  <Button onClick={() => setCreating(true)} disabled={!category}>
                    <Plus size={14} /> New Raw Material
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[720px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[160px]">SKU</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-[140px]">On hand</TableHead>
                    <TableHead className="w-[140px]">Stock status</TableHead>
                    <TableHead className="w-[120px]">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.uuid} interactive className="group">
                      <TableCell className="font-mono">
                        <Link
                          href={`/inventory/${encodeURIComponent(row.id)}/ledger`}
                          className="rounded-sm text-text hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          {row.id}
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-2">{row.desc}</TableCell>
                      <TableCell className="font-mono tabular-nums text-text">
                        {row.qty}
                        {row.uom ? (
                          <span className="ml-1 text-text-3">{row.uom}</span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="text-text-3">
                        {row.updatedAt
                          ? new Date(row.updatedAt).toLocaleDateString()
                          : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      </div>

      <NewItemDialog
        open={creating}
        onOpenChange={setCreating}
        lockedCategory={category}
        title="New Raw Material"
        description={
          category
            ? `Create a new raw material (${category.prefix} tier).`
            : undefined
        }
        submitLabel="Create Raw Material"
        onCreated={() => void fetchRows()}
      />
    </>
  );
}
