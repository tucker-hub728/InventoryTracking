'use client';

import * as React from 'react';
import Link from 'next/link';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { toast } from '@/components/ui/sonner';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermission } from '@/hooks/use-permission';
import { productsApi, type Product } from '@/lib/api/products';
import { ApiError } from '@/lib/api/client';

import { ProductFormDialog } from './product-form-dialog';

/**
 * Products list — finished goods built from inventory items via a BOM.
 * Each row shows its linked customers + material count. Create opens the
 * product form (name + materials array); edit renames; delete soft-deletes.
 */
export function ProductCatalogClient() {
  const canCreate = usePermission('inventory', 'create');

  const [products, setProducts] = React.useState<Product[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<Product | null>(null);
  const [deleting, setDeleting] = React.useState<Product | null>(null);

  const debounced = useDebouncedValue(query, 150);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await productsApi.list({}, { signal });
      setProducts(rows);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load products.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const filtered = React.useMemo(() => {
    const q = debounced.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.customers.some((c) => c.name.toLowerCase().includes(q)),
    );
  }, [products, debounced]);

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await productsApi.remove(deleting.id);
      toast.success('Product deleted', { description: deleting.name });
      setProducts((prev) => prev.filter((p) => p.id !== deleting.id));
    } catch (err) {
      toast.error('Delete failed', {
        description: err instanceof ApiError ? err.message : 'Please try again.',
      });
    }
  };

  const handleSaved = (saved: Product) => {
    setProducts((prev) => {
      const exists = prev.some((p) => p.id === saved.id);
      return exists ? prev.map((p) => (p.id === saved.id ? saved : p)) : [saved, ...prev];
    });
    toast.success(editing ? 'Product updated' : 'Product created', {
      description: saved.name,
    });
  };

  return (
    <>
      <PageHeader
        title="Products"
        subtitle="Finished goods built from inventory items via a bill of materials."
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> Add product
            </Button>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="p-4">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[260px] flex-1">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by product or customer"
                className="pl-9"
                aria-label="Search products"
              />
            </div>
            <div className="text-xs text-text-3">
              {loading ? 'Loading…' : `${filtered.length} of ${products.length}`}
            </div>
          </div>

          {loadError ? (
            <EmptyState
              title="Couldn't load products"
              hint={loadError}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          ) : !loading && products.length === 0 ? (
            <EmptyState
              title="No products yet"
              hint="Create a product and list the materials it consumes per run."
              action={
                canCreate ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus size={14} /> Add product
                  </Button>
                ) : undefined
              }
            />
          ) : !loading && filtered.length === 0 ? (
            <EmptyState title="No products match" hint="Try a different search." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                    <th className="px-3 py-2 font-medium">SKU</th>
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 font-medium">Customers</th>
                    <th className="px-3 py-2 text-right font-medium">Materials</th>
                    {canCreate && <th className="px-3 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr
                      key={p.id}
                      className="border-b border-border/60 transition-colors hover:bg-surface"
                    >
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/products/${p.id}`}
                          className="font-mono text-xs text-accent hover:underline"
                        >
                          {p.sku}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/products/${p.id}`}
                          className="font-medium text-text hover:underline"
                        >
                          {p.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5">
                        {p.customers.length === 0 ? (
                          <span className="text-text-3">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {p.customers.map((c) => (
                              <Badge key={c.id} tone="neutral">
                                {c.name}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs">
                        {p.material_count}
                      </td>
                      {canCreate && (
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              className="h-8 px-2"
                              onClick={() => setEditing(p)}
                              aria-label={`Edit ${p.name}`}
                            >
                              <Pencil size={14} />
                            </Button>
                            <Button
                              variant="ghost"
                              className="h-8 px-2 text-danger"
                              onClick={() => setDeleting(p)}
                              aria-label={`Delete ${p.name}`}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <ProductFormDialog open={creating} onOpenChange={setCreating} onSaved={handleSaved} />
      <ProductFormDialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        product={editing ?? undefined}
        onSaved={handleSaved}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        title="Delete product?"
        description={
          deleting ? (
            <>
              This archives <span className="font-medium">{deleting.name}</span> and its
              bill of materials. It can be recreated later.
            </>
          ) : undefined
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
      />
    </>
  );
}
