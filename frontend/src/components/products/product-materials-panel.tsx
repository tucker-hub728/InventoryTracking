'use client';

import * as React from 'react';
import Link from 'next/link';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { toast } from '@/components/ui/sonner';
import { usePermission } from '@/hooks/use-permission';
import { formatNumber } from '@/lib/utils';
import { materialsApi, type ProductMaterial } from '@/lib/api/products';
import { ApiError } from '@/lib/api/client';
import { STOCK_STATUS_META } from '@/config/inventory';

import { MaterialFormDialog } from './material-form-dialog';
import { useProductDetail } from './product-detail-context';

/**
 * Materials tab (route ``/products/[id]/material``) — the product's "Required
 * Materials per Production Run", with live stock. Add / edit / remove inline;
 * mutations refresh the product so the header's material count stays in sync.
 */
export function ProductMaterialsPanel({ productId }: { productId: string }) {
  const canCreate = usePermission('inventory', 'create');
  const { refreshProduct } = useProductDetail();

  const [materials, setMaterials] = React.useState<ProductMaterial[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [editMat, setEditMat] = React.useState<ProductMaterial | null>(null);
  const [removeMat, setRemoveMat] = React.useState<ProductMaterial | null>(null);

  const loadMaterials = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const rows = await materialsApi.list(productId, { signal });
        if (signal?.aborted) return;
        setMaterials(rows);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load materials.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [productId],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void loadMaterials(ctrl.signal);
    return () => ctrl.abort();
  }, [loadMaterials]);

  const refresh = React.useCallback(() => {
    void loadMaterials();
    refreshProduct();
  }, [loadMaterials, refreshProduct]);

  const handleRemove = async () => {
    if (!removeMat) return;
    try {
      await materialsApi.remove(removeMat.id);
      toast.success('Material removed', { description: removeMat.item_number });
      refresh();
    } catch (err) {
      toast.error('Remove failed', {
        description: err instanceof ApiError ? err.message : 'Please try again.',
      });
    }
  };

  const existingItemIds = materials.map((m) => m.item_id);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <h3 className="text-sm font-semibold">Required materials per production run</h3>
        {canCreate && (
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <Plus size={14} /> Add material
          </Button>
        )}
      </div>

      {error ? (
        <EmptyState
          title="Couldn't load materials"
          hint={error}
          action={<Button onClick={() => void loadMaterials()}>Retry</Button>}
        />
      ) : loading && materials.length === 0 ? (
        <div className="py-10 text-center text-sm text-text-3" role="status">
          Loading materials…
        </div>
      ) : materials.length === 0 ? (
        <EmptyState
          title="No materials yet"
          hint="Add the inventory items this product consumes, with the quantity used per run."
          action={
            canCreate ? (
              <Button variant="primary" onClick={() => setAddOpen(true)}>
                <Plus size={14} /> Add material
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                <th className="px-4 py-2 font-medium">Item ID</th>
                <th className="px-4 py-2 font-medium">Material</th>
                <th className="px-4 py-2 text-right font-medium">Qty / run</th>
                <th className="px-4 py-2 text-right font-medium">Available</th>
                <th className="px-4 py-2 font-medium">Stock status</th>
                {canCreate && <th className="px-4 py-2" />}
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => {
                const meta = STOCK_STATUS_META[m.status_code] ?? STOCK_STATUS_META.out_of_stock;
                return (
                  <tr
                    key={m.id}
                    className="border-b border-border/60 transition-colors hover:bg-surface"
                  >
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/inventory/${m.item_number}`}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        {m.item_number}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="line-clamp-1" title={m.item_name}>
                        {m.item_name}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      {formatNumber(Number(m.qty_per_run))}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      {formatNumber(Number(m.qty_available))}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={meta.tone} dot>
                        {meta.label}
                      </Badge>
                    </td>
                    {canCreate && (
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            className="h-8 px-2"
                            onClick={() => setEditMat(m)}
                            aria-label={`Edit ${m.item_number}`}
                          >
                            <Pencil size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            className="h-8 px-2 text-danger"
                            onClick={() => setRemoveMat(m)}
                            aria-label={`Remove ${m.item_number}`}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <MaterialFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        productId={productId}
        excludeItemIds={existingItemIds}
        onSaved={refresh}
      />
      <MaterialFormDialog
        open={editMat !== null}
        onOpenChange={(o) => {
          if (!o) setEditMat(null);
        }}
        productId={productId}
        material={editMat ?? undefined}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={removeMat !== null}
        onOpenChange={(o) => {
          if (!o) setRemoveMat(null);
        }}
        title="Remove material?"
        description={
          removeMat ? (
            <>
              Remove <span className="font-mono">{removeMat.item_number}</span> from this
              product&apos;s materials?
            </>
          ) : undefined
        }
        confirmLabel="Remove"
        variant="danger"
        onConfirm={handleRemove}
      />
    </>
  );
}
