import type { Metadata } from 'next';

import { TransactionsPageClient } from '@/components/transactions/transactions-page-client';

export const metadata: Metadata = {
  title: 'Transactions',
};

export default function TransactionsPage() {
  return <TransactionsPageClient />;
}
