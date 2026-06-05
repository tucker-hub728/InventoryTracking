import type { Metadata } from 'next';

import { ProductDetailClient } from '@/components/products/product-detail-client';

interface PageProps {
  params: { id: string };
}

export const metadata: Metadata = {
  title: 'Product',
};

export default function ProductDetailPage({ params }: PageProps) {
  return <ProductDetailClient productId={params.id} />;
}
