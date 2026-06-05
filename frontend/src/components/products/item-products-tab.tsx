'use client';

import * as React from 'react';
import Link from 'next/link';

import { EmptyState } from '@/components/shared/empty-state';
import { formatNumber } from '@/lib/utils';
import { productsApi, type Product } from '@/lib/api/products';
import { ApiError } from '@/lib/api/client';

/**
 * "Products" tab on an inventory item — the products whose bill of materials
 * uses this item (the inverse of a product's BOM). SKU links to the product.
 */
export function ItemProductsTab({ itemId }: { itemId: string }) {
  const [products, setProducts] = React.useState<Product[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    productsApi
      .usingItem(itemId, { signal: ctrl.signal })
      .then((rows) => setProducts(rows))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load products.');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [itemId]);

  if (error) {
    return <EmptyState title="Couldn't load products" hint={error} />;
  }
  if (loading && products.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-text-3" role="status">
        Loading products…
      </div>
    );
  }
  if (products.length === 0) {
    return (
      <EmptyState
        title="Not used in any product"
        hint="This item isn't part of any product's bill of materials yet."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
            <th className="px-4 py-2 font-medium">SKU</th>
            <th className="px-4 py-2 font-medium">Product name</th>
            <th className="px-4 py-2 text-right font-medium">Qty per run</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr
              key={p.id}
              className="border-b border-border/60 transition-colors hover:bg-surface"
            >
              <td className="px-4 py-2.5">
                <Link
                  href={`/products/${p.id}`}
                  className="font-mono text-xs text-accent hover:underline"
                >
                  {p.sku}
                </Link>
              </td>
              <td className="px-4 py-2.5">{p.name}</td>
              <td className="px-4 py-2.5 text-right font-mono text-xs">
                {p.qty_per_run != null ? formatNumber(Number(p.qty_per_run)) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
