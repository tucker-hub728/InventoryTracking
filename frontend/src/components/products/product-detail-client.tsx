'use client';

import * as React from 'react';
import Link from 'next/link';
import { notFound, useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { toast } from '@/components/ui/sonner';
import { usePermission } from '@/hooks/use-permission';
import { formatNumber } from '@/lib/utils';
import {
  productsApi,
  materialsApi,
  type Product,
  type ProductMaterial,
} from '@/lib/api/products';
import { ApiError } from '@/lib/api/client';

import { ProductFormDialog } from './product-form-dialog';
import { MaterialFormDialog } from './material-form-dialog';

interface Props {
  productId: string;
}

const STATUS_META: Record<
  ProductMaterial['status_code'],
  { label: string; tone: 'success' | 'warning' | 'danger' }
> = {
  available: { label: 'In Stock', tone: 'success' },
  low_stock: { label: 'Low Stock', tone: 'warning' },
  out_of_stock: { label: 'Critical', tone: 'danger' },
};

/**
 * Product detail — the product name + its "Required Materials per Production
 * Run". Each material shows the inventory item's live Available qty + stock
 * status. Add / edit / remove materials inline; rename or delete the product.
 */
export function ProductDetailClient({ productId }: Props) {
  const router = useRouter();
  const canCreate = usePermission('inventory', 'create');

  const [product, setProduct] = React.useState<Product | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const [materials, setMaterials] = React.useState<ProductMaterial[]>([]);
  const [matsLoading, setMatsLoading] = React.useState(true);
  const [matsError, setMatsError] = React.useState<string | null>(null);

  const [addOpen, setAddOpen] = React.useState(false);
  const [editMat, setEditMat] = React.useState<ProductMaterial | null>(null);
  const [removeMat, setRemoveMat] = React.useState<ProductMaterial | null>(null);

  const loadProduct = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const row = await productsApi.get(productId, { signal });
        if (signal?.aborted) return;
        setProduct(row);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        if (err instanceof ApiError && err.status === 404) {
          notFound();
          return;
        }
        setLoadError(err instanceof Error ? err.message : 'Failed to load product.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [productId],
  );

  const loadMaterials = React.useCallback(
    async (signal?: AbortSignal) => {
      setMatsLoading(true);
      setMatsError(null);
      try {
        const rows = await materialsApi.list(productId, { signal });
        if (signal?.aborted) return;
        setMaterials(rows);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setMatsError(err instanceof ApiError ? err.message : 'Failed to load materials.');
      } finally {
        if (!signal?.aborted) setMatsLoading(false);
      }
    },
    [productId],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void loadProduct(ctrl.signal);
    void loadMaterials(ctrl.signal);
    return () => ctrl.abort();
  }, [loadProduct, loadMaterials]);

  const refresh = React.useCallback(() => {
    void loadMaterials();
    void loadProduct();
  }, [loadMaterials, loadProduct]);

  const handleDeleteProduct = async () => {
    if (!product) return;
    try {
      await productsApi.remove(product.id);
      toast.success('Product deleted', { description: product.name });
      router.push('/products');
    } catch (err) {
      toast.error('Delete failed', {
        description: err instanceof ApiError ? err.message : 'Please try again.',
      });
    }
  };

  const handleRemoveMaterial = async () => {
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

  if (loading && product === null) {
    return (
      <>
        <DetailHeader />
        <div className="flex items-center gap-2 px-6 py-10 text-sm text-text-2 sm:px-8">
          <Loader2 size={14} className="animate-spin" /> Loading product…
        </div>
      </>
    );
  }

  if (loadError && product === null) {
    return (
      <>
        <DetailHeader />
        <div className="px-6 py-5 sm:px-8">
          <Card>
            <EmptyState
              title="Couldn't load product"
              hint={loadError}
              action={<Button onClick={() => void loadProduct()}>Retry</Button>}
            />
          </Card>
        </div>
      </>
    );
  }

  if (!product) return null;

  const existingItemIds = materials.map((m) => m.item_id);

  return (
    <>
      <PageHeader
        title={product.name}
        crumbs={[{ label: 'Products', href: '/products' }, { label: product.name }]}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-accent">{product.sku}</span>
            <span aria-hidden>·</span>
            <span>
              {product.material_count} material{product.material_count === 1 ? '' : 's'}
            </span>
            {product.customers.length > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="flex flex-wrap items-center gap-1">
                  {product.customers.map((c) => (
                    <Badge key={c.id} tone="neutral">
                      {c.name}
                    </Badge>
                  ))}
                </span>
              </>
            )}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link href="/products">
                <ArrowLeft size={14} /> Back
              </Link>
            </Button>
            {canCreate && (
              <>
                <Button onClick={() => setEditing(true)}>
                  <Pencil size={14} /> Edit
                </Button>
                <Button variant="danger" onClick={() => setDeleting(true)}>
                  <Trash2 size={14} /> Delete
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="min-w-0">
          <CardHeader className="flex-row items-center justify-between gap-3">
            <CardTitle>Required materials per production run</CardTitle>
            {canCreate && (
              <Button variant="primary" onClick={() => setAddOpen(true)}>
                <Plus size={14} /> Add material
              </Button>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {matsError ? (
              <EmptyState
                title="Couldn't load materials"
                hint={matsError}
                action={<Button onClick={() => void loadMaterials()}>Retry</Button>}
              />
            ) : matsLoading && materials.length === 0 ? (
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
                      const meta = STATUS_META[m.status_code] ?? STATUS_META.out_of_stock;
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
                            {formatNumber(Number(m.qty_on_hand))}
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
          </CardContent>
        </Card>
      </div>

      <ProductFormDialog
        open={editing}
        onOpenChange={setEditing}
        product={product}
        onSaved={(updated) => setProduct(updated)}
      />

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete product?"
        description={
          <>
            This archives <span className="font-medium">{product.name}</span> and its bill
            of materials. It can be recreated later.
          </>
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDeleteProduct}
      />

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
        onConfirm={handleRemoveMaterial}
      />
    </>
  );
}

function DetailHeader() {
  return (
    <PageHeader
      title="Product"
      crumbs={[{ label: 'Products', href: '/products' }, { label: '…' }]}
      actions={
        <Button variant="ghost" asChild>
          <Link href="/products">
            <ArrowLeft size={14} /> Back
          </Link>
        </Button>
      }
    />
  );
}
