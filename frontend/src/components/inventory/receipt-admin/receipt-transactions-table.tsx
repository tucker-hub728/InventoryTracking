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
          <TableHead className="text-right">Received</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => {
          const canReceiveRow =
            order.status === 'open' || order.status === 'partially_received';
          const pct =
            order.total_ordered_qty > 0
              ? Math.round(
                  (order.total_received_qty / order.total_ordered_qty) * 100,
                )
              : 0;
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
              <TableCell className="text-right tabular-nums text-text-2">
                {order.total_received_qty}/{order.total_ordered_qty}
                <span className="ml-1 text-xs text-text-3">({pct}%)</span>
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
