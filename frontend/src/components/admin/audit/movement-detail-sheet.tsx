'use client';

import * as React from 'react';

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  MOVEMENT_TYPE_LABEL,
  type ApiMovement,
  type MovementType,
} from '@/lib/api/movements';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Selected ledger row. ``null`` keeps the sheet mounted but empty so
   *  the close animation still plays. */
  movement: ApiMovement | null;
}

/** Per-movement-type pill, matching the timeline icon-tint palette. */
const TYPE_STYLE: Record<MovementType, string> = {
  receipt: 'border-success/40 bg-success/10 text-success',
  transfer_in: 'border-accent/40 bg-accent/10 text-accent',
  dispense: 'border-warning/40 bg-warning/10 text-warning',
  discard: 'border-danger/40 bg-danger/10 text-danger',
  transfer_out: 'border-warning/40 bg-warning/10 text-warning',
  adjustment: 'border-accent/40 bg-accent/10 text-accent',
};

/**
 * Side-sheet detail view for a single stock movement. Mirrors the
 * ``AuditDetailSheet`` layout (header strip, KV grid) so the ledger and
 * audit-timeline rows feel like the same product.
 *
 * No re-fetch — the timeline already holds the joined row, so this is
 * purely a presentational view. If we later need fresh data (e.g. for
 * deep-links), the same shape can be hydrated from
 * ``movementsApi.get(id)``.
 */
export function MovementDetailSheet({ open, onOpenChange, movement }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-2xl">
        <SheetHeader>
          <SheetTitle>Stock movement</SheetTitle>
          <SheetDescription>
            Quantities, lot, locations, and the reason recorded with the
            electronic signature.
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          {movement ? (
            <MovementBody movement={movement} />
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function MovementBody({ movement }: { movement: ApiMovement }) {
  const typeLabel = MOVEMENT_TYPE_LABEL[movement.movement_type];
  const qtyDelta = Number(movement.qty_delta);
  const qtyAbs = Number(movement.qty_abs).toLocaleString();
  const sign = qtyDelta > 0 ? '+' : qtyDelta < 0 ? '−' : '';
  const signTint =
    qtyDelta > 0
      ? 'text-success'
      : qtyDelta < 0
        ? 'text-danger'
        : 'text-text-2';

  return (
    <div className="space-y-6 text-sm">
      {/* ── Header strip ─────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] uppercase tracking-wide',
              TYPE_STYLE[movement.movement_type],
            )}
          >
            {typeLabel}
          </span>
          <span className={cn('font-mono text-base font-semibold', signTint)}>
            {sign}
            {qtyAbs}
          </span>
        </div>
        <p className="text-xs text-text-3">
          <span className="font-mono">
            {new Date(movement.performed_at).toLocaleString()}
          </span>{' '}
          · by{' '}
          {movement.performed_by_user_name ? (
            <>
              <span className="font-medium text-text-1">
                {movement.performed_by_user_name}
              </span>{' '}
              {movement.performed_by_user_email && (
                <span className="text-text-3">
                  ({movement.performed_by_user_email})
                </span>
              )}
            </>
          ) : (
            <span className="text-text-2">unknown</span>
          )}
        </p>
      </div>

      {/* ── Subject ──────────────────────────────────────────── */}
      <KvGrid>
        <KV
          label="Item"
          value={
            movement.item_number ? (
              <span>
                <span className="font-mono">{movement.item_number}</span>
                {movement.item_description && (
                  <span className="text-text-2">
                    {' '}
                    · {movement.item_description}
                  </span>
                )}
              </span>
            ) : (
              '—'
            )
          }
        />
        <KV
          label="Lot"
          value={
            movement.lot_number ? (
              <span className="font-mono">{movement.lot_number}</span>
            ) : (
              '—'
            )
          }
        />
        <KV
          label="From"
          value={
            movement.from_location_node_name ? (
              <span title={movement.from_location_node_path ?? undefined}>
                {movement.from_location_node_name}
              </span>
            ) : (
              '—'
            )
          }
        />
        <KV
          label="To"
          value={
            movement.to_location_node_name ? (
              <span title={movement.to_location_node_path ?? undefined}>
                {movement.to_location_node_name}
              </span>
            ) : (
              '—'
            )
          }
        />
        {movement.notes && <KV label="Comment" value={movement.notes} />}
        <KV
          label="Movement ID"
          value={<span className="font-mono text-xs">{movement.id}</span>}
        />
        {movement.reauth_evidence_id && (
          <KV
            label="Evidence"
            value={
              <span className="font-mono text-xs">
                {movement.reauth_evidence_id}
              </span>
            }
          />
        )}
      </KvGrid>
    </div>
  );
}

function KvGrid({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[100px_1fr] gap-x-4 gap-y-1.5">{children}</dl>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs text-text-3">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </>
  );
}
