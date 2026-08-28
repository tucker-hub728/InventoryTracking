import { type ReactNode } from 'react';
import type { Metadata } from 'next';

import { CustomerDetailShell } from '@/components/customers/customer-detail-shell';

interface LayoutProps {
  children: ReactNode;
  params: Promise<{ id: string }>;
}

// The route segment is the customer's UUID, which is meaningless as a tab
// title — the shell renders the real name in the page header once it loads.
export function generateMetadata(): Metadata {
  return { title: 'Customer' };
}

export default async function CustomerDetailLayout(props: LayoutProps) {
  const params = await props.params;
  const { children } = props;

  return <CustomerDetailShell customerId={params.id}>{children}</CustomerDetailShell>;
}
