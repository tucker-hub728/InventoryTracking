'use client';

import * as React from 'react';
import { ArrowDownToLine, ArrowLeftRight, History } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import {
  transactionsApi,
  type ApiTransactionListRow,
  type TransactionType,
} from '@/lib/api/transactions';
import { itemsApi, type ApiItem } from '@/lib/api/items';
import { locationsApi, type ApiLocation } from '@/lib/api/locations';
import { ReceiveDialog } from './receive-dialog';
import { TransferDialog } from './transfer-dialog';
import { TransactionDetailSheet } from './transaction-detail-sheet';

type TypeFilter = 'all' | TransactionType;

function typeTone(t: string): 'success' | 'accent' | 'neutral' {
  if (t === 'receipt') return 'success';
  if (t === 'transfer') return 'accent';
  return 'neutral';
}

export function TransactionsPageClient() {
  const canCreate = usePermission('transactions', 'create');

  const [typeFilter, setTypeFilter] = React.useState<TypeFilter>('all');
  const [rows, setRows] = React.useState<ApiTransactionListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [items, setItems] = React.useState<ApiItem[]>([]);
  const [locations, setLocations] = React.useState<ApiLocation[]>([]);

  const [openDialog, setOpenDialog] = React.useState<null | 'receive' | 'transfer'>(null);
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

  // Reference data for the forms.
  React.useEffect(() => {
    const ctrl = new AbortController();
    itemsApi
      .list({ tier: 'CR', active: true }, { signal: ctrl.signal })
      .then(setItems)
      .catch(() => {});
    locationsApi
      .list({ active: true }, { signal: ctrl.signal })
      .then(setLocations)
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  const onCreated = () => {
    setOpenDialog(null);
    void load();
  };

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Transactions"
        subtitle="Receipt and transfer history, newest first."
        actions={
          canCreate ? (
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setOpenDialog('receive')}>
                <ArrowDownToLine size={15} /> Receive
              </Button>
              <Button onClick={() => setOpenDialog('transfer')}>
                <ArrowLeftRight size={15} /> Transfer
              </Button>
            </div>
          ) : undefined
        }
      />

      <div className="px-6 py-4 sm:px-8">
        <div className="w-44">
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
          ) : rows.length === 0 ? (
            <EmptyState icon={History} title="No transactions yet" hint="Receive stock to get started." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Transaction #</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead>Created by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((tx) => (
                  <TableRow key={tx.id} interactive onClick={() => setDetailId(tx.id)}>
                    <TableCell className="font-mono text-xs">{tx.transaction_no}</TableCell>
                    <TableCell>
                      <Badge tone={typeTone(tx.transaction_type)} className="capitalize">
                        {tx.transaction_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-text-2">
                      {new Date(tx.transaction_date).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-text-2">
                      {tx.reference_no ?? <span className="text-text-3">—</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{tx.line_count}</TableCell>
                    <TableCell className="text-text-2">
                      {tx.created_by_name ?? tx.created_by}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      <ReceiveDialog
        open={openDialog === 'receive'}
        onOpenChange={(o) => setOpenDialog(o ? 'receive' : null)}
        items={items}
        locations={locations}
        onCreated={onCreated}
      />
      <TransferDialog
        open={openDialog === 'transfer'}
        onOpenChange={(o) => setOpenDialog(o ? 'transfer' : null)}
        items={items}
        locations={locations}
        onCreated={onCreated}
      />
      <TransactionDetailSheet
        transactionId={detailId}
        onOpenChange={(o) => {
          if (!o) setDetailId(null);
        }}
      />
    </div>
  );
}
