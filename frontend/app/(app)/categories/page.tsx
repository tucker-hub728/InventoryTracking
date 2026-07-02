import type { Metadata } from 'next';

import { CategoriesPageClient } from '@/components/categories/categories-page-client';

export const metadata: Metadata = {
  title: 'Item Categories',
};

export default function CategoriesPage() {
  return <CategoriesPageClient />;
}
