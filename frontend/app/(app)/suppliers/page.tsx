import type { Metadata } from 'next';

import { SuppliersPageClient } from '@/components/admin/suppliers/suppliers-page-client';

export const metadata: Metadata = {
  title: 'Suppliers',
};

export default function SuppliersPage() {
  return <SuppliersPageClient />;
}
