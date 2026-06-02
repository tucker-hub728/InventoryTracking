'use client';

import * as React from 'react';
import { Pencil, RotateCcw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Vendor } from '@/lib/api/vendors';

interface VendorsTableProps {
  vendors: Vendor[];
  loading: boolean;
  /** Row actions — when omitted the action column is hidden. */
  onEdit?: (v: Vendor) => void;
  onDeactivate?: (v: Vendor) => void;
  onReactivate?: (v: Vendor) => void;
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

export function VendorsTable({
  vendors,
  loading,
  onEdit,
  onDeactivate,
  onReactivate,
  busyId,
}: VendorsTableProps) {
  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-text-3" role="status">
        Loading vendors…
      </div>
    );
  }

  const showActions = Boolean(onEdit || onDeactivate || onReactivate);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Contact</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Added</th>
            {showActions && <th className="px-3 py-2 font-medium" />}
          </tr>
        </thead>
        <tbody>
          {vendors.map((v) => (
            <tr
              key={v.id}
              className={cn(
                'group border-b border-border/60 transition-colors hover:bg-surface',
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
                  <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    {onEdit && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        onClick={() => onEdit(v)}
                        disabled={busyId === v.id}
                        title="Edit vendor"
                      >
                        <Pencil size={12} aria-hidden /> Edit
                      </Button>
                    )}
                    {v.is_active && onDeactivate && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-warning hover:bg-warning/10"
                        onClick={() => onDeactivate(v)}
                        disabled={busyId === v.id}
                        title="Deactivate vendor"
                      >
                        <Trash2 size={12} aria-hidden /> Deactivate
                      </Button>
                    )}
                    {!v.is_active && onReactivate && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-success hover:bg-success/10"
                        onClick={() => onReactivate(v)}
                        disabled={busyId === v.id}
                        title="Reactivate vendor"
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
