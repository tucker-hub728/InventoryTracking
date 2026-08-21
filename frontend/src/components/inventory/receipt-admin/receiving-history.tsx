'use client';

import * as React from 'react';
import { AlertTriangle, Pencil } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ReleaseStateBadge } from '@/components/inventory/release-state-badge';
import { ItemLink } from '@/components/inventory/item-link';
import { cn, daysFromNow, formatDate, formatNumber } from '@/lib/utils';
import type { Order, OrderLine, ReceiptEventLine } from '@/lib/api/receiving';

/**
 * What actually arrived against an Order, as a record you can read down.
 *
 * The list this replaces printed one flat line per draw:
 *
 *     2026-08-21                                    by Super Admin
 *     123  CR-SMK8326P — smoke: no pack  +148  (Accellix)   [pencil]
 *
 * Four things were wrong with it, and only the first is cosmetic.
 *
 * **`+148` was a lie of omission.** Since REQ-001 an item is ordered in one
 * unit and stocked in another, so on that row 148 meant 148 *Cases* — 3,700
 * units. The number a receiver or an auditor actually needs, how much physical
 * material landed, was the one number not on the row. Two orders of magnitude,
 * invisible, in a cell-therapy facility. Every quantity here therefore carries
 * its unit, and where the two differ both are shown, with the stock figure —
 * the one that matters downstream — given the visual weight.
 *
 * **It repeated what never changed and omitted what did.** The item number and
 * description were reprinted verbatim on every row; on a single-item order that
 * is the same string N times. Meanwhile expiry, quality state and price — the
 * facts that decide whether the material is usable, and the reasons someone
 * opens a receiving record at all — were absent. So the item is now hoisted to
 * a group heading when the whole order is one item, and the freed room spends
 * itself on what varies per delivery.
 *
 * **It made you do arithmetic.** "Is this done, and what got us here" meant
 * subtracting down the page. Each delivery now carries its running total, so
 * the last row answers the question the panel exists to answer.
 *
 * **It gave every fact the same voice.** A junk lot number, a routine receipt
 * and an over-receipt needing a reason on file all rendered identically.
 * Colour is now spent only on things worth interrupting for — over-receipt,
 * expired or expiring stock — and never carries meaning alone: each has a word
 * beside it, because a regulated log has to survive a colour-blind reader.
 */

/** Expiry inside this window is worth flagging on sight, not on hover. */
const EXPIRY_WARN_DAYS = 30;

interface Props {
  order: Order;
  /** Whether the viewer may correct a lot (drives the edit affordance). */
  canEdit: boolean;
  onEditLot: (lotId: string) => void;
}

/** One draw, joined to the Order line it was received against. */
interface Draw {
  el: ReceiptEventLine;
  line: OrderLine | undefined;
  /** Units of THIS item received up to and including this draw. */
  cumulativeUnits: number;
}

interface EventGroup {
  id: string;
  receivedAt: string;
  by: string;
  notes: string | null;
  draws: Draw[];
}

export function ReceivingHistory({ order, canEdit, onEditLot }: Props) {
  const groups = React.useMemo<EventGroup[]>(() => {
    const byLine = new Map(order.lines.map((l) => [l.id, l]));

    // Oldest first: this is a history, and a running total that counts
    // downward is not a running total. The API returns events newest-first.
    const chronological = [...order.events].sort((a, b) =>
      a.received_at === b.received_at
        ? a.created_at.localeCompare(b.created_at)
        : a.received_at.localeCompare(b.received_at),
    );

    const runningByLine = new Map<string, number>();
    return chronological.map((ev) => ({
      id: ev.id,
      receivedAt: ev.received_at,
      by: ev.received_by_user_name ?? `${ev.received_by_user_id.slice(0, 8)}…`,
      notes: ev.notes,
      draws: ev.lines.map((el) => {
        const line = byLine.get(el.line_id);
        const units = el.units_received ?? el.qty_received;
        const running = (runningByLine.get(el.line_id) ?? 0) + units;
        runningByLine.set(el.line_id, running);
        return { el, line, cumulativeUnits: running };
      }),
    }));
  }, [order]);

  // The item is constant on a single-item order, so printing it per row is
  // noise. Hoist it, and fall back to per-row labelling when it genuinely varies.
  const singleItem =
    order.lines.length > 0 &&
    order.lines.every((l) => l.item_id === order.lines[0]!.item_id)
      ? order.lines[0]
      : null;

  if (groups.length === 0) return <EmptyState />;

  return (
    <div>
      <Summary order={order} />

      {singleItem && (
        <p className="mb-3 flex flex-wrap items-baseline gap-x-2 text-xs text-text-3">
          <ItemLink
            itemNumber={singleItem.item_number}
            itemId={singleItem.item_id}
            className="font-mono text-accent"
          />
          {singleItem.item_description && <span>{singleItem.item_description}</span>}
          {singleItem.supplier_name && <span>· {singleItem.supplier_name}</span>}
        </p>
      )}

      <ol className="space-y-0">
        {groups.map((g, i) => (
          <li key={g.id} className="relative flex gap-3">
            {/* The rail. Purely decorative — the ordered list already carries
                the sequence for a screen reader, so it is aria-hidden and the
                last segment stops rather than trailing into nothing. */}
            <div aria-hidden className="flex w-3 shrink-0 flex-col items-center pt-1.5">
              <span className="size-2 shrink-0 rounded-full border border-border-strong bg-surface" />
              {i < groups.length - 1 && (
                <span className="mt-1 w-px flex-1 bg-border" />
              )}
            </div>

            <div className={cn('min-w-0 flex-1', i < groups.length - 1 && 'pb-4')}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="text-sm font-medium text-text-2">
                  {formatDate(g.receivedAt)}
                </span>
                <span className="text-xs text-text-3">{g.by}</span>
              </div>

              {g.notes && (
                <p className="mt-1 text-xs italic text-text-3">{g.notes}</p>
              )}

              <div className="mt-2 space-y-2">
                {g.draws.map((d) => (
                  <DrawRow
                    key={d.el.id}
                    draw={d}
                    showItem={!singleItem}
                    canEdit={canEdit}
                    onEditLot={onEditLot}
                  />
                ))}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** One received lot: what it is, how much, and anything wrong with it. */
function DrawRow({
  draw,
  showItem,
  canEdit,
  onEditLot,
}: {
  draw: Draw;
  showItem: boolean;
  canEdit: boolean;
  onEditLot: (lotId: string) => void;
}) {
  const { el, line, cumulativeUnits } = draw;
  const packUom = line?.pack_uom ?? null;
  const units = el.units_received ?? el.qty_received;
  // Only worth printing both when they differ — on a line with no pack the
  // two are the same number and showing it twice is the old noise problem
  // wearing a new coat.
  const showBoth = packUom != null && units !== el.qty_received;
  const targetUnits = line?.ordered_units ?? null;

  const expiryDays = daysFromNow(el.expiration_date);
  const expired = expiryDays != null && expiryDays < 0;
  const expiringSoon =
    expiryDays != null && expiryDays >= 0 && expiryDays <= EXPIRY_WARN_DAYS;

  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* A lot number can be 64 chars; it wraps rather than pushing the
              quantity off the row, because the quantity is the point. */}
          <span className="break-all font-mono text-xs text-accent">
            {el.lot_number ?? '—'}
          </span>
          {showItem && line && (
            <span className="ml-2 text-xs text-text-3">
              <ItemLink
                itemNumber={line.item_number}
                itemId={line.item_id}
                className="font-mono"
              />
            </span>
          )}
        </div>

        <div className="shrink-0 text-right">
          <div className="font-medium tabular-nums text-text-1">
            +{formatNumber(units)}
            <span className="ml-1 text-xs font-normal text-text-3">units</span>
          </div>
          {showBoth && (
            <div className="text-[11px] tabular-nums text-text-3">
              {formatNumber(el.qty_received)} {packUom} × {line?.units_per_pack}
            </div>
          )}
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-3">
        {targetUnits != null && targetUnits > 0 && (
          <span className="tabular-nums">
            {formatNumber(cumulativeUnits)} of {formatNumber(targetUnits)} received
          </span>
        )}

        {el.expiration_date && (
          <span
            className={cn(
              'tabular-nums',
              expired && 'font-medium text-danger',
              expiringSoon && 'font-medium text-warning',
            )}
          >
            {/* The word carries the state; the colour only reinforces it. */}
            {expired ? 'Expired' : 'Expires'} {formatDate(el.expiration_date)}
            {expiringSoon && ` · ${expiryDays}d`}
          </span>
        )}

        {el.unit_price_amount != null && (
          <span className="tabular-nums">
            ${trimPrice(el.unit_price_amount)}/unit
          </span>
        )}

        <ReleaseStateBadge state={el.release_state} size="xs" />

        {el.over_receipt_reason != null && (
          <span className="inline-flex items-center gap-1 font-medium text-warning">
            <AlertTriangle size={11} aria-hidden />
            Over-receipt: {el.over_receipt_reason}
          </span>
        )}

        {canEdit && el.lot_id && (
          <Button
            size="icon-sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => onEditLot(el.lot_id)}
            aria-label={`Edit lot ${el.lot_number ?? ''}`}
          >
            <Pencil size={12} />
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The one-line answer, above the detail: how much of this order has landed.
 *
 * Reported in CONSUME units, because that is what is on a shelf and what every
 * downstream screen counts. Lines with no pack contribute their own numbers
 * unchanged, so a mixed order still sums to something true.
 */
function Summary({ order }: { order: Order }) {
  const target = order.lines.reduce((n, l) => n + (l.ordered_units || 0), 0);
  const outstanding = order.lines.reduce((n, l) => n + (l.outstanding_units || 0), 0);
  const received = Math.max(0, target - outstanding);
  if (target <= 0) return null;

  const pct = Math.min(100, Math.round((received / target) * 100));
  const complete = outstanding === 0;
  const over = received > target;

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className="tabular-nums text-text-2">
          <span className="font-medium text-text-1">{formatNumber(received)}</span>
          {' of '}
          {formatNumber(target)} units received
        </span>
        <span
          className={cn(
            'font-medium',
            complete ? 'text-success' : 'text-text-3',
            over && 'text-warning',
          )}
        >
          {over
            ? 'Over-received'
            : complete
              ? 'Complete'
              : `${formatNumber(outstanding)} outstanding`}
        </span>
      </div>
      <div
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Units received against this order"
      >
        <div
          className={cn(
            'h-full rounded-full',
            over ? 'bg-warning' : complete ? 'bg-success' : 'bg-accent',
          )}
          style={{ width: `${Math.max(pct, received > 0 ? 2 : 0)}%` }}
        />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center">
      <p className="text-sm text-text-2">Nothing received yet</p>
      <p className="mt-0.5 text-xs text-text-3">
        Deliveries against this order will appear here, newest at the bottom.
      </p>
    </div>
  );
}

/**
 * A per-unit price is stored at six decimals because it is usually a division
 * ($95.00 over a case of 25). Printing all six turns "$3.80" into "$3.800000";
 * printing two would round $0.008333 to "$0.01", an eightfold overstatement on
 * a cheap consumable. So: trim trailing zeros, but never round away a value
 * that would otherwise read as zero.
 */
function trimPrice(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (n === 0) return '0.00';
  const fixed = n >= 0.01 ? n.toFixed(2) : n.toFixed(6);
  return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
