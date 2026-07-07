'use client';

import * as React from 'react';

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/api/client';
import { transactionsApi, type ApiTransactionDetail } from '@/lib/api/transactions';
import { toNum } from '@/lib/api/helpers';

interface Props {
  transactionId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function TransactionDetailSheet({ transactionId, onOpenChange }: Props) {
  const [detail, setDetail] = React.useState<ApiTransactionDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!transactionId) {
      setDetail(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    transactionsApi
      .get(transactionId, { signal: ctrl.signal })
      .then(setDetail)
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load transaction.');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [transactionId]);

  return (
    <Sheet open={transactionId !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{detail?.transaction_no ?? 'Transaction'}</SheetTitle>
          <SheetDescription>{detail?.id ?? transactionId ?? ''}</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          {loading ? (
            <div className="py-12 text-center text-sm text-text-3">Loading…</div>
          ) : error ? (
            <div className="py-12 text-center text-sm text-danger">{error}</div>
          ) : detail ? (
            <>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <Field label="Type">
                  <Badge className="capitalize">{detail.transaction_type}</Badge>
                </Field>
                <Field label="Date">{new Date(detail.transaction_date).toLocaleString()}</Field>
                <Field label="Reference">{detail.reference_no ?? '—'}</Field>
                <Field label="Created by">{detail.created_by_name ?? detail.created_by}</Field>
                {detail.notes && (
                  <div className="col-span-2">
                    <dt className="text-[11px] uppercase tracking-wider text-text-3">Notes</dt>
                    <dd className="mt-1 text-text">{detail.notes}</dd>
                  </div>
                )}
              </dl>

              <div>
                <h3 className="mb-2 text-sm font-semibold">Lines</h3>
                <div className="overflow-hidden rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead>From</TableHead>
                        <TableHead>To</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead>Lot</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.lines.map((line) => (
                        <TableRow key={line.id}>
                          <TableCell>
                            <div className="font-mono text-xs">{line.item_code ?? line.item_id}</div>
                            {line.item_name && (
                              <div className="text-xs text-text-3">{line.item_name}</div>
                            )}
                          </TableCell>
                          <TableCell className="text-text-2">
                            {line.from_location_name ?? <span className="text-text-3">—</span>}
                          </TableCell>
                          <TableCell className="text-text-2">
                            {line.to_location_name ?? <span className="text-text-3">—</span>}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {toNum(line.quantity).toLocaleString()} {line.unit_of_measure}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {line.lot_number ?? <span className="text-text-3">—</span>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </>
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-text-3">{label}</dt>
      <dd className="mt-1 text-text">{children}</dd>
    </div>
  );
}
