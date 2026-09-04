'use client';

import * as React from 'react';
import { Pencil, RotateCcw, Trash2 } from 'lucide-react';

import {
  TableRowsSkeleton,
  type SkeletonColumn,
} from '@/components/shared/table-rows-skeleton';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Supplier } from '@/lib/api/suppliers';

interface SuppliersTableProps {
  suppliers: Supplier[];
  loading: boolean;
  /** Row actions — when omitted the action column is hidden. */
  onEdit?: (v: Supplier) => void;
  onDeactivate?: (v: Supplier) => void;
  onReactivate?: (v: Supplier) => void;
  /** IDs whose row-level action is in flight; used to disable the button. */
  busyId?: string | null;
}

function formatDate(iso: string): string {
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

/** Matches the real cells: Name carries a notes sub-line, Status is a pill,
 *  Actions are right-aligned buttons. */
const SKELETON_COLUMNS: readonly SkeletonColumn[] = [
  { width: 'w-40', subWidth: 'w-24' },
  { width: 'w-44', subWidth: 'w-20' },
  { width: 'w-14' },
  { width: 'w-16', pill: true },
  { width: 'w-20' },
  { width: 'w-40', align: 'right' },
];

export function SuppliersTable({
  suppliers,
  loading,
  onEdit,
  onDeactivate,
  onReactivate,
  busyId,
}: SuppliersTableProps) {
  const showActions = Boolean(onEdit || onDeactivate || onReactivate);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Contact</th>
            {/* PLN-001 — drives the reorder warning for every item this
                supplier stocks. */}
            <th className="px-3 py-2 font-medium">Lead time</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Added</th>
            {showActions && <th className="px-3 py-2 font-medium" />}
          </tr>
        </thead>
        <tbody>
          {loading && (
            // Inside the real table so the columns keep their final widths and
            // nothing shifts when the rows land.
            <TableRowsSkeleton
              columns={showActions ? SKELETON_COLUMNS : SKELETON_COLUMNS.slice(0, 5)}
              rows={8}
              cellClassName="border-b border-border/60 px-3 py-2.5 align-middle"
              label="Loading suppliers…"
            />
          )}
          {!loading && suppliers.map((v) => (
            <tr
              key={v.id}
              className={cn(
                'border-b border-border/60 transition-colors hover:bg-surface',
                !v.is_active && 'text-text-3',
              )}
            >
              <td className="px-3 py-2.5">
                <div className="font-medium text-text">{v.name}</div>
                {v.notes && (
                  <div className="mt-0.5 truncate text-[11px] text-text-3" title={v.notes}>
                    {v.notes}
                  </div>
                )}
              </td>
              <td className="px-3 py-2.5">
                {v.contact_email ? (
                  <a
                    href={`mailto:${v.contact_email}`}
                    className="text-accent hover:underline"
                  >
                    {v.contact_email}
                  </a>
                ) : (
                  <span className="text-text-3">—</span>
                )}
                {v.phone && <div className="text-[11px] text-text-3">{v.phone}</div>}
              </td>
              {/* "Not set" rather than a dash or a 0: an unrecorded lead time
                  is a supplier nobody has asked, and reading it as no wait is
                  the mistake PLN-001 exists to prevent. */}
              <td className="px-3 py-2.5 whitespace-nowrap">
                {v.lead_time_days == null ? (
                  <span className="text-text-3">Not set</span>
                ) : (
                  <span className="text-text-2">
                    {v.lead_time_days} day{v.lead_time_days === 1 ? '' : 's'}
                  </span>
                )}
              </td>
              <td className="px-3 py-2.5">
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px]',
                    v.is_active
                      ? 'border-success/30 bg-success/5 text-success'
                      : 'border-border bg-surface text-text-3',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      v.is_active ? 'bg-success' : 'bg-text-3',
                    )}
                    aria-hidden
                  />
                  {v.is_active ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td className="px-3 py-2.5 text-text-3">{formatDate(v.created_at)}</td>
              {showActions && (
                <td className="px-3 py-2.5 text-right">
                  {/* Always rendered, never revealed on hover. A hover-only
                      control is invisible to anyone who isn't already pointing
                      at the row: it can't be found by scanning the page, and on
                      a touch screen there is no hover state at all. */}
                  <div className="flex items-center justify-end gap-1">
                    {onEdit && (
                      <Button
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => onEdit(v)}
                        disabled={busyId === v.id}
                        title="Edit supplier"
                      >
                        <Pencil size={12} aria-hidden /> Edit
                      </Button>
                    )}
                    {v.is_active && onDeactivate && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-warning hover:bg-warning/10"
                        onClick={() => onDeactivate(v)}
                        disabled={busyId === v.id}
                        title="Deactivate supplier"
                      >
                        <Trash2 size={12} aria-hidden /> Deactivate
                      </Button>
                    )}
                    {!v.is_active && onReactivate && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-success hover:bg-success/10"
                        onClick={() => onReactivate(v)}
                        disabled={busyId === v.id}
                        title="Reactivate supplier"
                      >
                        <RotateCcw size={12} aria-hidden /> Reactivate
                      </Button>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
