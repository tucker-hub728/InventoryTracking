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
import type { BadgeTone } from '@/types/ui';
import {
  ORDER_STATUS_LABEL,
  type Order,
  type OrderStatus,
} from '@/lib/api/receiving';
import { ReceiveProgress } from './receive-progress';

const STATUS_TONE: Record<OrderStatus, BadgeTone> = {
  open: 'accent',
  partially_received: 'warning',
  received: 'success',
  cancelled: 'neutral',
};

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

interface Props {
  orders: Order[];
  canReceive: boolean;
  onView: (order: Order) => void;
  onReceive: (order: Order) => void;
}

export function ReceiptTransactionsTable({
  orders,
  canReceive,
  onView,
  onReceive,
}: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Order #</TableHead>
          <TableHead className="text-right">Items</TableHead>
          {/* The cell below is a fixed three-slot block (counts · meter ·
              remainder) pinned to the right edge. Matching that width here
              parks the label over the counts rather than over the whitespace
              that trails a short remainder like "1 left". */}
          <TableHead className="text-right">
            <span className="inline-block w-[13.75rem] text-left">Received</span>
          </TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => {
          const canReceiveRow =
            order.status === 'open' || order.status === 'partially_received';
          return (
            <TableRow key={order.id}>
              <TableCell>
                <button
                  type="button"
                  onClick={() => onView(order)}
                  className="font-mono text-xs text-accent transition-opacity hover:opacity-80"
                >
                  {order.po_reference}
                </button>
                {order.is_blanket && (
                  <Badge tone="accent" className="ml-2 align-middle">
                    Blanket
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {order.lines.length}
              </TableCell>
              <TableCell className="text-right">
                <ReceiveProgress order={order} />
              </TableCell>
              <TableCell>
                <Badge tone={STATUS_TONE[order.status]} dot>
                  {ORDER_STATUS_LABEL[order.status]}
                </Badge>
              </TableCell>
              <TableCell className="text-text-3">
                {formatDate(order.created_at)}
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => onView(order)}>
                    <Eye size={14} /> View
                  </Button>
                  {canReceive && canReceiveRow && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => onReceive(order)}
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
