import type { Metadata } from 'next';

import { ProductCatalogClient } from '@/components/products/product-catalog-client';

export const metadata: Metadata = {
  title: 'Products',
};

export default function ProductsPage() {
  return <ProductCatalogClient />;
}
