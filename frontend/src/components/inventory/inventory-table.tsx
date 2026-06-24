'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { useInventoryStore, type SortKey } from '@/stores/inventory.store';
import { cn, formatNumber } from '@/lib/utils';
import type { InventoryItem } from '@/types/inventory';

// Only the columns the backend can actually sort on are clickable. UI-only
// columns (vendor / qty / status) read sort state but don't drive it; we'd
// need new backend sort fields to make them sortable.
interface Column {
  key: keyof InventoryItem | 'lastUpdated';
  label: string;
  align?: 'left' | 'right';
  sortKey?: SortKey;
  className?: string;
}

// Widths drive a ``table-fixed`` layout so long names / vendors get
// ellipsised rather than blowing out the column. The wrapper has
// ``overflow-auto`` so the total width below acts as a min-width on
// narrow viewports — under ~1100 px the table scrolls horizontally
// rather than crushing each column.
const COLUMNS: Column[] = [
  { key: 'id', label: 'Item ID', sortKey: 'id', className: 'w-[110px]' },
  { key: 'desc', label: 'Name', sortKey: 'desc' },
  { key: 'vendor', label: 'Vendor', className: 'w-[160px]' },
  { key: 'qty', label: 'Units', align: 'right', className: 'w-[96px]' },
  { key: 'onOrder', label: 'On PO', align: 'right', className: 'w-[80px]' },
  { key: 'threshold', label: 'Reorder', align: 'right', className: 'w-[90px]' },
  // "Exp. Risk" was driven by ``item.expires`` which the API adapter
  // doesn't populate yet (per-item lot expiry isn't rolled up at item
  // level). Column re-lands once ``v_item_lot_summary`` ships.
  { key: 'status', label: 'Stock status', className: 'w-[130px]' },
  { key: 'lastUpdated', label: 'Updated', sortKey: 'lastUpdated', className: 'w-[120px]' },
];

function formatUpdated(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function InventoryTable({ rows }: { rows: InventoryItem[] }) {
  const sortKey = useInventoryStore((s) => s.sortKey);
  const sortDir = useInventoryStore((s) => s.sortDir);
  const toggleSort = useInventoryStore((s) => s.toggleSort);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No items match"
        hint="Adjust filters or refine your search."
      />
    );
  }

  return (
    <Table className="min-w-[1100px] table-fixed">
      <TableHeader>
        <TableRow>
          {COLUMNS.map((c) => {
            const isActive = c.sortKey !== undefined && sortKey === c.sortKey;
            const Arrow = isActive ? (sortDir === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;
            const sortable = c.sortKey !== undefined;
            return (
              <TableHead
                key={c.key}
                className={cn(c.className, c.align === 'right' && 'text-right')}
                aria-sort={
                  isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
                }
              >
                {sortable ? (
                  <button
                    type="button"
                    onClick={() => toggleSort(c.sortKey!)}
                    className="inline-flex items-center gap-1 text-inherit transition-colors hover:text-text"
                  >
                    {c.label}
                    <Arrow size={11} className={cn(!isActive && 'opacity-60')} aria-hidden />
                  </button>
                ) : (
                  c.label
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((item) => {
          const lowQty = item.qtyAvailable > 0 && item.qtyAvailable <= item.threshold;
          // Units shown = available (excludes date-expired lots), clamped at 0
          // so a data artifact (expired-lot units exceeding on-hand) never
          // renders a confusing negative. Any expired remainder is still
          // physically on hand — surfaced as a hint so it's visible from the
          // list, not just detail.
          const availableShown = Math.max(0, item.qtyAvailable);
          const expired = Math.max(0, item.qty - item.qtyAvailable);
          return (
            <TableRow key={item.id} className="group">
              <TableCell className="font-mono text-xs">
                <Link
                  href={`/inventory/${item.id}/ledger`}
                  className="text-accent transition-opacity hover:opacity-80"
                >
                  {item.id}
                </Link>
              </TableCell>
              <TableCell className="truncate">
                <Link
                  href={`/inventory/${item.id}/ledger`}
                  title={item.desc}
                  className="text-sm font-medium text-text transition-colors hover:text-accent"
                >
                  {item.desc}
                </Link>
              </TableCell>
              <TableCell className="truncate text-xs text-text-2" title={item.vendor}>
                {item.vendor || '—'}
              </TableCell>
              <TableCell
                className={cn(
                  'text-right font-mono text-xs',
                  item.qtyAvailable <= 0 && 'text-danger',
                  lowQty && 'text-warning',
                )}
              >
                <div className="flex flex-col items-end leading-tight">
                  <span className="font-semibold">{formatNumber(availableShown)}</span>
                  {expired > 0 && (
                    <span
                      className="text-[10px] font-normal text-text-3"
                      title={`${formatNumber(expired)} expired unit(s) on hand (excluded from available)`}
                    >
                      +{formatNumber(expired)} exp
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-text-2">
                {item.onOrder > 0 ? formatNumber(item.onOrder) : '—'}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-text-2">
                {item.threshold > 0 ? formatNumber(item.threshold) : '—'}
              </TableCell>
              <TableCell>
                <StatusBadge status={item.status} />
              </TableCell>
              <TableCell className="font-mono text-xs text-text-2">
                {formatUpdated(item.updatedAt)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
