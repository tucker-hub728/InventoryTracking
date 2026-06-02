'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { LOT_STATUS_LABEL, type Lot, type LotStatus } from '@/lib/api/lots';

interface LotsTableProps {
  lots: Lot[];
  loading: boolean;
}

function formatDate(iso: string | null): string {
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

const STATUS_TONE: Record<LotStatus, string> = {
  released: 'border-success/30 bg-success/5 text-success',
  quarantined: 'border-accent/30 bg-accent/5 text-accent',
  expired: 'border-warning/30 bg-warning/5 text-warning',
  recalled: 'border-danger/30 bg-danger/5 text-danger',
};

export function LotsTable({ lots, loading }: LotsTableProps) {
  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-text-3" role="status">
        Loading lots…
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
            <th className="px-3 py-2 font-medium">Lot #</th>
            <th className="px-3 py-2 font-medium">Item</th>
            <th className="px-3 py-2 font-medium">Vendor</th>
            <th className="px-3 py-2 font-medium">Mfg date</th>
            <th className="px-3 py-2 font-medium">Expires</th>
            <th className="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {lots.map((l) => (
            <tr key={l.id} className="border-b border-border/60 transition-colors hover:bg-surface">
              <td className="px-3 py-2.5 font-mono text-xs">{l.lot_number}</td>
              <td className="px-3 py-2.5">
                <div className="font-mono text-xs text-accent">{l.item_number ?? '—'}</div>
                <div
                  className="mt-0.5 truncate text-[11px] text-text-3"
                  title={l.item_description ?? ''}
                >
                  {l.item_description ?? ''}
                </div>
              </td>
              <td className="px-3 py-2.5 text-xs text-text-2">
                {l.vendor_name ?? <span className="text-text-3">—</span>}
              </td>
              <td className="px-3 py-2.5 text-text-3">{formatDate(l.manufacture_date)}</td>
              <td className="px-3 py-2.5 text-text-3">{formatDate(l.expiration_date)}</td>
              <td className="px-3 py-2.5">
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px]',
                    STATUS_TONE[l.status],
                  )}
                >
                  {LOT_STATUS_LABEL[l.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
