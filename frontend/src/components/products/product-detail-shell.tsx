'use client';

import * as React from 'react';
import Link from 'next/link';
import { notFound, usePathname, useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Pencil, Trash2 } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { toast } from '@/components/ui/sonner';
import { usePermission } from '@/hooks/use-permission';
import { cn } from '@/lib/utils';
import { productsApi, type Product } from '@/lib/api/products';
import { ApiError } from '@/lib/api/client';

import { ProductFormDialog } from './product-form-dialog';
import { ProductDetailProvider } from './product-detail-context';

const TABS = [
  { seg: 'material', label: 'Materials' },
  { seg: 'forecast', label: 'Forecast' },
  { seg: 'customers', label: 'Customers' },
] as const;

/**
 * Shared chrome for a product's detail routes (``/products/[id]/material``,
 * ``/forecast``, ``/customers``). Fetches the product once, renders the header +
 * tab-link bar + edit/delete dialogs, and shares the product (and a refresh
 * callback) with the active route via context. The route segment under
 * ``[id]`` is rendered as ``children``.
 */
export function ProductDetailShell({
  productId,
  children,
}: {
  productId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const canCreate = usePermission('inventory', 'create');

  const [product, setProduct] = React.useState<Product | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

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

  React.useEffect(() => {
    const ctrl = new AbortController();
    void loadProduct(ctrl.signal);
    return () => ctrl.abort();
  }, [loadProduct]);

  const refreshProduct = React.useCallback(() => {
    void loadProduct();
  }, [loadProduct]);

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

  const activeSeg = pathname.split('/').pop();

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
                <span>
                  {product.customers.length} customer{product.customers.length === 1 ? '' : 's'}
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
        <Card className="min-w-0 overflow-hidden">
          <div className="border-b border-border px-4">
            <nav className="inline-flex items-center justify-start gap-1" aria-label="Product sections">
              {TABS.map((t) => {
                const active = activeSeg === t.seg;
                return (
                  <Link
                    key={t.seg}
                    href={`/products/${product.id}/${t.seg}`}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      '-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3.5 py-2.5 text-sm font-normal text-text-2 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      active && 'border-text font-medium text-text',
                    )}
                  >
                    {t.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <ProductDetailProvider value={{ product, refreshProduct }}>{children}</ProductDetailProvider>
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
            This archives <span className="font-medium">{product.name}</span> and its bill of
            materials. It can be recreated later.
          </>
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDeleteProduct}
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
