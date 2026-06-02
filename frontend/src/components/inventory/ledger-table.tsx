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

export function LedgerTable({ entries, onReverseRequest }: Props) {
  if (entries.length === 0) {
    return <EmptyState title="No movements yet" hint="Recorded transactions will appear here." />;
  }

  const showActions = Boolean(onReverseRequest);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[120px]">Date</TableHead>
          <TableHead className="w-[80px] text-right">In</TableHead>
          <TableHead className="w-[80px] text-right">Out</TableHead>
          <TableHead className="w-[100px] text-right">Balance</TableHead>
          <TableHead className="w-[120px]">Location</TableHead>
          <TableHead className="w-[140px]">Lot</TableHead>
          <TableHead className="w-[120px]">Expiry</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead className="w-[160px]">By</TableHead>
          {showActions && <TableHead className="w-[80px]" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e, i) => {
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
              key={e.movementId ?? `${e.date}-${i}`}
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
              <TableCell className={cn('text-right font-mono text-xs font-semibold')}>
                {e.balance}
              </TableCell>
              <TableCell className="font-mono text-xs text-text-2">{e.location}</TableCell>
              <TableCell className="font-mono text-xs text-text-2">{e.lot}</TableCell>
              <TableCell className="font-mono text-xs text-text-2">{e.exp}</TableCell>
              <TableCell className="text-xs text-text-2">
                {e.reason}
                {e.isReversal && (
                  <span className="ml-2 rounded-sm bg-bg-elev px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-3">
                    Reversal
                  </span>
                )}
                {e.isReversed && (
                  <span className="ml-2 rounded-sm bg-bg-elev px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-3">
                    Reversed
                  </span>
                )}
              </TableCell>
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
                    <span
                      className="text-[10px] text-text-3"
                      title={reverseHint}
                    >
                      {/* keeps column width stable */}
                    </span>
                  )}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
