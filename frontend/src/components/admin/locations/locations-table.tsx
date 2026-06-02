'use client';

import * as React from 'react';
import { Pencil, RotateCcw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { LOCATION_KIND_LABEL, type Location } from '@/lib/api/locations';

interface LocationsTableProps {
  locations: Location[];
  loading: boolean;
  onEdit?: (l: Location) => void;
  onDeactivate?: (l: Location) => void;
  onReactivate?: (l: Location) => void;
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

function formatTemp(t: string | null): string {
  if (t == null || t === '') return '—';
  const n = Number(t);
  return Number.isFinite(n) ? `${n} °C` : t;
}

export function LocationsTable({
  locations,
  loading,
  onEdit,
  onDeactivate,
  onReactivate,
  busyId,
}: LocationsTableProps) {
  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-text-3" role="status">
        Loading locations…
      </div>
    );
  }

  const showActions = Boolean(onEdit || onDeactivate || onReactivate);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
            <th className="px-3 py-2 font-medium">Code</th>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 font-medium text-right">Temp</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Added</th>
            {showActions && <th className="px-3 py-2 font-medium" />}
          </tr>
        </thead>
        <tbody>
          {locations.map((l) => (
            <tr
              key={l.id}
              className={cn(
                'group border-b border-border/60 transition-colors hover:bg-surface',
                !l.is_active && 'text-text-3',
              )}
            >
              <td className="px-3 py-2.5 font-mono text-xs">{l.code}</td>
              <td className="px-3 py-2.5">
                <div className="font-medium text-text">{l.name}</div>
                {l.notes && (
                  <div className="mt-0.5 truncate text-[11px] text-text-3" title={l.notes}>
                    {l.notes}
                  </div>
                )}
              </td>
              <td className="px-3 py-2.5 text-xs text-text-2">
                {LOCATION_KIND_LABEL[l.kind] ?? l.kind}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatTemp(l.temperature_c)}</td>
              <td className="px-3 py-2.5">
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px]',
                    l.is_active
                      ? 'border-success/30 bg-success/5 text-success'
                      : 'border-border bg-surface text-text-3',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      l.is_active ? 'bg-success' : 'bg-text-3',
                    )}
                    aria-hidden
                  />
                  {l.is_active ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td className="px-3 py-2.5 text-text-3">{formatDate(l.created_at)}</td>
              {showActions && (
                <td className="px-3 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    {onEdit && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        onClick={() => onEdit(l)}
                        disabled={busyId === l.id}
                        title="Edit location"
                      >
                        <Pencil size={12} aria-hidden /> Edit
                      </Button>
                    )}
                    {l.is_active && onDeactivate && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-warning hover:bg-warning/10"
                        onClick={() => onDeactivate(l)}
                        disabled={busyId === l.id}
                        title="Deactivate location"
                      >
                        <Trash2 size={12} aria-hidden /> Deactivate
                      </Button>
                    )}
                    {!l.is_active && onReactivate && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-success hover:bg-success/10"
                        onClick={() => onReactivate(l)}
                        disabled={busyId === l.id}
                        title="Reactivate location"
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
