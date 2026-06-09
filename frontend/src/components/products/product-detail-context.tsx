'use client';

import * as React from 'react';

import type { Product } from '@/lib/api/products';

export interface ProductDetailContextValue {
  product: Product;
  /** Re-fetch the product (e.g. after a material change updates its count). */
  refreshProduct: () => void;
}

const ProductDetailContext = React.createContext<ProductDetailContextValue | null>(null);

/** Provided by the product detail layout/shell; consumed by the tab panels. */
export function ProductDetailProvider({
  value,
  children,
}: {
  value: ProductDetailContextValue;
  children: React.ReactNode;
}) {
  return (
    <ProductDetailContext.Provider value={value}>{children}</ProductDetailContext.Provider>
  );
}

export function useProductDetail(): ProductDetailContextValue {
  const ctx = React.useContext(ProductDetailContext);
  if (!ctx) {
    throw new Error('useProductDetail must be used within the product detail layout');
  }
  return ctx;
}
