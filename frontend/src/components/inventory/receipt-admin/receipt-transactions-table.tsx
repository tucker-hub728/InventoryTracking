'use client';

import * as React from 'react';
import { Eye, PackageCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  RECEIPT_STATUS_LABEL,
  type ReceiptTransaction,
  type ReceiptTransactionStatus,
} from '@/lib/api/receiving';

const STATUS_TONE: Record<ReceiptTransactionStatus, 'accent' | 'success' | 'neutral'> = {
  open: 'accent',
  received: 'success',
  cancelled: 'neutral',
};

function formatDate(iso: string): string {
  // Render the calendar date only (intake/receipt are day-grained in the UI).
  return iso.slice(0, 10);
}

interface Props {
  transactions: ReceiptTransaction[];
  canReceive: boolean;
  onView: (txn: ReceiptTransaction) => void;
  onReceive: (txn: ReceiptTransaction) => void;
}

export function ReceiptTransactionsTable({
  transactions,
  canReceive,
  onView,
  onReceive,
}: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Item</TableHead>
          <TableHead>PO #</TableHead>
          <TableHead className="text-right">Lots</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {transactions.map((txn) => {
          const isOpen = txn.status === 'open';
          const liveLots = txn.lots.length;
          return (
            <TableRow key={txn.id}>
              <TableCell>
                <span className="font-mono text-xs text-accent">
                  {txn.item_number ?? '—'}
                </span>
                {txn.item_description && (
                  <span className="ml-2 text-text-2">{txn.item_description}</span>
                )}
              </TableCell>
              <TableCell className="text-text-2">
                {txn.po_reference ?? <span className="text-text-3">—</span>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{liveLots}</TableCell>
              <TableCell>
                <Badge tone={STATUS_TONE[txn.status]} dot>
                  {RECEIPT_STATUS_LABEL[txn.status]}
                </Badge>
              </TableCell>
              <TableCell className="text-text-3">{formatDate(txn.created_at)}</TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => onView(txn)}>
                    <Eye size={14} /> View
                  </Button>
                  {isOpen && canReceive && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => onReceive(txn)}
                    >
                      <PackageCheck size={14} /> Receive
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
