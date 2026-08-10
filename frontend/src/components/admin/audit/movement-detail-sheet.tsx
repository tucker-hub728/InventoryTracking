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
import { MOVEMENT_TYPE_LABEL, type ApiMovement, type MovementType } from '@/lib/api/movements';
import { ItemLink } from '@/components/inventory/item-link';
import { LotLink } from '@/components/inventory/lot-link';
import { LocationLink } from '@/components/locations/location-link';
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
  // Kitting / back-flush: issues leave stock (warning), output + back-flush
  // bring it back in (success).
  kit_issue: 'border-warning/40 bg-warning/10 text-warning',
  kit_additional_issue: 'border-warning/40 bg-warning/10 text-warning',
  production_output: 'border-success/40 bg-success/10 text-success',
  backflush: 'border-success/40 bg-success/10 text-success',
  kit_return: 'border-accent/40 bg-accent/10 text-accent',
  kit_cancel_return: 'border-warning/40 bg-warning/10 text-warning',
  customer_shipment: 'border-warning/40 bg-warning/10 text-warning',
  consumable_issue: 'border-warning/40 bg-warning/10 text-warning',
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
            Quantities, lot, locations, and the reason recorded with the electronic signature.
          </SheetDescription>
        </SheetHeader>

        <SheetBody>{movement ? <MovementBody movement={movement} /> : null}</SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function MovementBody({ movement }: { movement: ApiMovement }) {
  const typeLabel = MOVEMENT_TYPE_LABEL[movement.movement_type];
  const qtyDelta = Number(movement.qty_delta);
  const qtyAbs = Number(movement.qty_abs).toLocaleString();
  const sign = qtyDelta > 0 ? '+' : qtyDelta < 0 ? '−' : '';
  const signTint = qtyDelta > 0 ? 'text-success' : qtyDelta < 0 ? 'text-danger' : 'text-text-2';

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
          <span className="font-mono">{new Date(movement.performed_at).toLocaleString()}</span> · by{' '}
          {movement.performed_by_user_name ? (
            <>
              <span className="text-text-1 font-medium">{movement.performed_by_user_name}</span>{' '}
              {movement.performed_by_user_email && (
                <span className="text-text-3">({movement.performed_by_user_email})</span>
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
                <ItemLink
                  itemNumber={movement.item_number}
                  itemId={movement.item_id}
                  className="font-mono"
                />
                {movement.item_description && (
                  <span className="text-text-2"> · {movement.item_description}</span>
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
              <LotLink
                lotId={movement.lot_id}
                lotNumber={movement.lot_number}
                className="font-mono"
              />
            ) : (
              '—'
            )
          }
        />
        {/* Where a kit's batch was BUILT. Not a movement end — a
            ``production_output`` mints a new lot, so nothing moved from
            anywhere and ``From`` is legitimately blank (the DB requires it,
            exactly as for a receipt). The floor is still the answer to "where
            was this made", so it gets its own line rather than being forced
            into From, which would claim stock left the floor. */}
        {movement.kit_production_location_name && (
          <KV
            label="Made in"
            value={
              <LocationLink
                nodeId={movement.kit_production_location_node_id}
                name={movement.kit_production_location_name}
              />
            }
          />
        )}
        {/* Both ends open the page the location lives on — same link the ledger's
            Location column uses, so the two views behave alike. */}
        <KV
          label="From"
          value={
            movement.from_location_node_name ? (
              <LocationLink
                nodeId={movement.from_location_node_id}
                name={movement.from_location_node_name}
                path={movement.from_location_node_path}
              />
            ) : movement.movement_type === 'production_output' ? (
              // Say why it is blank, so it doesn't read as missing data.
              <span className="text-text-3">— new stock, not moved</span>
            ) : (
              '—'
            )
          }
        />
        <KV
          label="To"
          value={
            movement.to_location_node_name ? (
              <LocationLink
                nodeId={movement.to_location_node_id}
                name={movement.to_location_node_name}
                path={movement.to_location_node_path}
              />
            ) : (
              '—'
            )
          }
        />
        {/* Customer shipment (CUST-001 / TRX-005): who the finished good left
            inventory to, and the reference / tracking number. */}
        {movement.movement_type === 'customer_shipment' && (
          <KV
            label="Customer"
            value={
              movement.customer_name ?? (
                <span className="italic text-text-3">Catalog (no customer)</span>
              )
            }
          />
        )}
        {movement.reference_number && (
          <KV label="Reference" value={movement.reference_number} />
        )}
        {movement.notes && <KV label="Comment" value={movement.notes} />}
        <KV label="Movement ID" value={<span className="font-mono text-xs">{movement.id}</span>} />
        {movement.reauth_evidence_id && (
          <KV
            label="Evidence"
            value={<span className="font-mono text-xs">{movement.reauth_evidence_id}</span>}
          />
        )}
      </KvGrid>
    </div>
  );
}

function KvGrid({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-[100px_1fr] gap-x-4 gap-y-1.5">{children}</dl>;
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs text-text-3">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </>
  );
}
