'use client';

import * as React from 'react';
import { History, Search } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination, usePagination } from '@/components/ui/pagination';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { ApiError } from '@/lib/api/client';
import {
  transactionsApi,
  type ApiTransactionListRow,
  type TransactionType,
} from '@/lib/api/transactions';
import { transactionTypeLabel, transactionTypeTone } from '@/lib/transaction-display';
import { TransactionDetailSheet } from './transaction-detail-sheet';

type TypeFilter = 'all' | TransactionType;

export function TransactionsPageClient() {
  const [typeFilter, setTypeFilter] = React.useState<TypeFilter>('all');
  const [rawSearch, setRawSearch] = React.useState('');
  const search = useDebouncedValue(rawSearch, 200);

  const [rows, setRows] = React.useState<ApiTransactionListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [detailId, setDetailId] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const resp = await transactionsApi.list(
          { type: typeFilter === 'all' ? undefined : typeFilter, limit: 100 },
          { signal },
        );
        const sorted = [...resp.items].sort(
          (a, b) => +new Date(b.transaction_date) - +new Date(a.transaction_date),
        );
        setRows(sorted);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load transactions.');
      } finally {
        setLoading(false);
      }
    },
    [typeFilter],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Client-side search over transaction # + who created it.
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (tx) =>
        tx.transaction_no.toLowerCase().includes(q) ||
        (tx.created_by_name ?? tx.created_by).toLowerCase().includes(q),
    );
  }, [rows, search]);

  const pg = usePagination(filtered, 10);

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader title="Transactions" subtitle="Receipt and transfer history, newest first." />

      <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:px-8">
        <div className="w-full sm:max-w-xs">
          <Input
            icon={Search}
            value={rawSearch}
            onChange={(e) => setRawSearch(e.target.value)}
            placeholder="Search transaction # or user…"
            aria-label="Search transactions"
          />
        </div>
        <div className="w-full sm:w-44">
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
            <SelectTrigger aria-label="Filter by type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="receipt">Receipt</SelectItem>
              <SelectItem value="transfer">Transfer</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1 px-6 pb-8 sm:px-8">
        <div className="overflow-hidden rounded-lg border border-border bg-bg-elev">
          {error ? (
            <EmptyState title="Couldn't load transactions" hint={error} />
          ) : loading ? (
            <div className="px-5 py-16 text-center text-sm text-text-3">Loading…</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={History}
              title={search ? 'No matching transactions' : 'No transactions yet'}
              hint={search ? 'Try a different search.' : 'Receive stock to get started.'}
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Transaction #</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Created by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pg.pageItems.map((tx) => (
                    <TableRow key={tx.id} interactive onClick={() => setDetailId(tx.id)}>
                      <TableCell className="font-mono text-xs">{tx.transaction_no}</TableCell>
                      <TableCell>
                        <Badge tone={transactionTypeTone(tx.transaction_type)}>
                          {transactionTypeLabel(tx.transaction_type)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-text-2">
                        {new Date(tx.transaction_date).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-text-2">
                        {tx.created_by_name ?? tx.created_by}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                page={pg.page}
                pageCount={pg.pageCount}
                total={pg.total}
                rangeStart={pg.rangeStart}
                rangeEnd={pg.rangeEnd}
                onPageChange={pg.setPage}
                noun="transaction"
              />
            </>
          )}
        </div>
      </div>

      <TransactionDetailSheet
        transactionId={detailId}
        onOpenChange={(o) => {
          if (!o) setDetailId(null);
        }}
      />
    </div>
  );
}
