'use client';

import * as React from 'react';
import { ArrowDownLeft, ArrowUpRight, Undo2 } from 'lucide-react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/empty-state';
import type { LedgerEntry } from '@/types/inventory';
import { cn } from '@/lib/utils';

interface Props {
  entries: LedgerEntry[];
  /**
   * Invoked when the operator clicks the per-row Reverse action. When
   * omitted, the action column is hidden — used by read-only viewers
   * who lack the ``inventory:sign`` permission.
   */
  onReverseRequest?: (entry: LedgerEntry) => void;
}

interface LotGroup {
  lot: string;
  rows: LedgerEntry[];
  totalIn: number;
  totalOut: number;
  balance: number;
}

/**
 * Group ledger rows by lot, preserving first-appearance order. Each group
 * carries its own Units-In / Units-Out / Balance subtotal — mirroring the
 * demo workbook's per-item ledger sheet (a "Total" row per lot, then an
 * item grand total at the bottom).
 */
function groupByLot(entries: LedgerEntry[]): LotGroup[] {
  const order: string[] = [];
  const byLot = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const lot = e.lot || '—';
    let bucket = byLot.get(lot);
    if (!bucket) {
      bucket = [];
      byLot.set(lot, bucket);
      order.push(lot);
    }
    bucket.push(e);
  }
  return order.map((lot) => {
    const rows = byLot.get(lot)!;
    const totalIn = rows.reduce((s, e) => s + e.in, 0);
    const totalOut = rows.reduce((s, e) => s + e.out, 0);
    return { lot, rows, totalIn, totalOut, balance: totalIn - totalOut };
  });
}

export function LedgerTable({ entries, onReverseRequest }: Props) {
  const showActions = Boolean(onReverseRequest);

  if (entries.length === 0) {
    return <EmptyState title="No movements yet" hint="Recorded transactions will appear here." />;
  }

  const groups = groupByLot(entries);
  const grandIn = groups.reduce((s, g) => s + g.totalIn, 0);
  const grandOut = groups.reduce((s, g) => s + g.totalOut, 0);
  const grandBalance = grandIn - grandOut;
  const cols = showActions ? 9 : 8;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[120px]">Date</TableHead>
          <TableHead className="w-[90px] text-right">Units In</TableHead>
          <TableHead className="w-[90px] text-right">Units Out</TableHead>
          <TableHead className="w-[100px] text-right">Balance</TableHead>
          <TableHead className="w-[160px]">Location</TableHead>
          <TableHead className="w-[140px]">Lot</TableHead>
          <TableHead className="w-[120px]">Expiry</TableHead>
          <TableHead className="w-[160px]">By</TableHead>
          {showActions && <TableHead className="w-[80px]" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <React.Fragment key={group.lot}>
            {group.rows.map((e, i) => {
              const canReverse =
                showActions &&
                Boolean(e.movementId) &&
                !e.isReversal &&
                !e.isReversed;
              const reverseHint = e.isReversal
                ? 'Cannot reverse a reversal'
                : e.isReversed
                  ? 'Already reversed'
                  : undefined;
              return (
                <TableRow
                  key={e.movementId ?? `${group.lot}-${e.date}-${i}`}
                  className={cn(
                    'group',
                    e.isReversal && 'bg-bg-elev/60',
                    e.isReversed && 'opacity-70',
                  )}
                >
                  <TableCell className="font-mono text-xs">{e.date}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {e.in > 0 ? (
                      <span className="inline-flex items-center gap-1 text-success">
                        <ArrowDownLeft size={11} aria-hidden /> {e.in}
                      </span>
                    ) : (
                      <span className="text-text-3">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {e.out > 0 ? (
                      <span className="inline-flex items-center gap-1 text-danger">
                        <ArrowUpRight size={11} aria-hidden /> {e.out}
                      </span>
                    ) : (
                      <span className="text-text-3">—</span>
                    )}
                  </TableCell>
                  {/* Per-row balance lives on the lot Total row, like the workbook. */}
                  <TableCell className="text-right font-mono text-xs text-text-3">—</TableCell>
                  <TableCell className="font-mono text-xs text-text-2">{e.location}</TableCell>
                  <TableCell className="font-mono text-xs text-text-2">{e.lot}</TableCell>
                  <TableCell className="font-mono text-xs text-text-2">{e.exp}</TableCell>
                  <TableCell className="text-xs text-text-2">
                    {e.actorName ? (
                      <span className="block truncate" title={e.actorName}>
                        {e.actorName}
                      </span>
                    ) : (
                      <span className="text-text-3">—</span>
                    )}
                  </TableCell>
                  {showActions && (
                    <TableCell className="text-right">
                      {canReverse ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="row-action h-7 px-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => onReverseRequest?.(e)}
                          title="Reverse this movement"
                        >
                          <Undo2 size={12} aria-hidden /> Reverse
                        </Button>
                      ) : (
                        <span className="text-[10px] text-text-3" title={reverseHint} />
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}

            {/* Per-lot subtotal — highlighted like the workbook's yellow lot totals */}
            <TableRow className="border-t border-warning/30 bg-warning-soft font-semibold">
              <TableCell className="text-[11px] uppercase tracking-wide text-warning">
                Total
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-success">
                {group.totalIn}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-danger">
                {group.totalOut}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">{group.balance}</TableCell>
              <TableCell />
              <TableCell className="font-mono text-xs text-text-2">{group.lot}</TableCell>
              <TableCell />
              <TableCell />
              {showActions && <TableCell />}
            </TableRow>
          </React.Fragment>
        ))}

        {/* Item grand total */}
        <TableRow className="border-t-2 border-accent/40 bg-accent-soft font-bold">
          <TableCell className="text-[11px] uppercase tracking-wide">Item total</TableCell>
          <TableCell className="text-right font-mono text-sm text-success">{grandIn}</TableCell>
          <TableCell className="text-right font-mono text-sm text-danger">{grandOut}</TableCell>
          <TableCell className="text-right font-mono text-sm">{grandBalance}</TableCell>
          <TableCell colSpan={cols - 4} />
        </TableRow>
      </TableBody>
    </Table>
  );
}
