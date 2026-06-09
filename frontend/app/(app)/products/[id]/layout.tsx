import { type ReactNode } from 'react';
import type { Metadata } from 'next';

import { ProductDetailShell } from '@/components/products/product-detail-shell';

export const metadata: Metadata = {
  title: 'Product',
};

interface LayoutProps {
  children: ReactNode;
  params: { id: string };
}

export default function ProductDetailLayout({ children, params }: LayoutProps) {
  return <ProductDetailShell productId={params.id}>{children}</ProductDetailShell>;
}
