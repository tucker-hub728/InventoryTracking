'use client';

import * as React from 'react';
import { Scale } from 'lucide-react';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import {
  CellGridPicker,
  useBoxGrid,
} from '@/components/reconciliation/cell-grid-picker';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import { locationNodesApi } from '@/lib/api/location-nodes';
import { formatNumber } from '@/lib/utils';

/** The row being corrected — one lot at one location. */
export interface AdjustTarget {
  lot_id: string;
  lot_number: string | null;
  node_id: string;
  /** Human location label, for the dialog's own copy. */
  location: string;
  /** What the record currently says is here. */
  qty: number;
  is_grid: boolean;
}

type Direction = 'in' | 'out';

const DIRECTIONS = [
  { value: 'out', label: 'Remove (out)' },
  { value: 'in', label: 'Add (in)' },
] as const;

interface UseStockAdjustOptions {
  /** The (lot × location) being corrected, or null when nothing is. */
  target: AdjustTarget | null;
  /** Called after the correction posts, before the caller closes its view. */
  onDone: () => void;
}

interface StockAdjust {
  /** The form itself — direction, quantity or vials, and any error. */
  fields: React.ReactNode;
  /** The e-signature step. Render it as a SIBLING of whatever chrome holds
   *  ``fields``, never nested inside it. */
  reauth: React.ReactNode;
  /** Validate, then raise the signature prompt. Wire this to the caller's own
   *  submit button, wherever that button has to live. */
  openSign: () => void;
  submitting: boolean;
}

/**
 * The stock-correction form, minus its chrome (REQ-2026-08-13-CTL-002).
 *
 * The counting correction: the shelf holds 58 where the record says 60, or 3
 * vials turn up that were never recorded. It posts one signed ``adjustment``
 * movement against a ``(lot × location)`` — a real ledger row, with this
 * location on it.
 *
 * It deliberately does NOT touch the lot's received quantity. ``ordered_qty``
 * records what *arrived*; a miscount months later does not change that, and
 * rewriting it would put the lot at odds with the placement cap. The two
 * numbers answer different questions and the ledger is where the difference
 * belongs.
 *
 * Direction is a choice rather than a signed number: ``qty`` is always how many
 * units and the segmented control says which way. A minus sign is too easy to
 * lose in a form, and "remove 5" is what the operator is actually doing.
 *
 * An LN2 box holds one unit per position, so there the quantity is a
 * consequence of which positions were picked and is never typed — going out
 * the operator taps the exact vials, going in the free positions to fill.
 *
 * This is a hook rather than a component because it has two homes with
 * different chrome: a dialog of its own from "Stock by location", and a *view*
 * inside the Edit lot dialog, which cannot open a second dialog on top of
 * itself. Returning the pieces separately lets each caller keep its own header
 * and footer, and keeps the rules — the cap, the cell shapes, the toast — in
 * exactly one place.
 */
export function useStockAdjust({
  target,
  onDone,
}: UseStockAdjustOptions): StockAdjust {
  const [direction, setDirection] = React.useState<Direction>('out');
  const [qty, setQty] = React.useState('');
  const [cellKeys, setCellKeys] = React.useState<string[]>([]);
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const grid = useBoxGrid(target?.is_grid ? target.node_id : null);

  // Reset every time a different row is opened — a form that remembers the
  // last row's quantity is how someone adjusts the wrong number of vials.
  React.useEffect(() => {
    setDirection('out');
    setQty('');
    setCellKeys([]);
    setFormError(null);
    setShowReauth(false);
    setSubmitting(false);
  }, [target?.lot_id, target?.node_id]);

  // Switching direction invalidates the selection: the two modes pick from
  // different sets (occupied vials vs free positions) and the keys are not
  // interchangeable — a source key is an allocation id, a destination key is
  // "row:col".
  const onDirectionChange = (next: string) => {
    setDirection(next as Direction);
    setCellKeys([]);
    setQty('');
    setFormError(null);
  };

  const isGrid = target?.is_grid ?? false;
  // For a box the count IS the selection; elsewhere the operator types it.
  const effectiveQty = isGrid ? cellKeys.length : Number(qty);

  /** This lot's occupied positions — what "remove" may draw from. Filtered
   *  from the box's full occupancy so another lot's vial can never be picked,
   *  while `useBoxGrid` still knows about it for the "add" direction, where
   *  any occupied cell blocks placement whatever is in it. */
  const lotCells = React.useMemo(
    () => (grid.grid?.cells ?? []).filter((c) => c.lot_id === target?.lot_id),
    [grid.grid, target?.lot_id],
  );

  const validate = (): string | null => {
    if (!target) return 'No row selected.';
    if (isGrid) {
      if (cellKeys.length === 0) {
        return direction === 'out'
          ? 'Select the vials to remove.'
          : 'Select the positions to fill.';
      }
    } else {
      if (!Number.isInteger(effectiveQty) || effectiveQty < 1) {
        return 'Quantity must be a whole number of at least 1.';
      }
    }
    if (direction === 'out' && effectiveQty > target.qty) {
      return `Only ${formatNumber(target.qty)} here — you cannot remove more than that.`;
    }
    return null;
  };

  const openSign = () => {
    const problem = validate();
    setFormError(problem);
    if (problem) return;
    setShowReauth(true);
  };

  const submit = async (evidence: ReauthResponse) => {
    if (!target) return;
    const problem = validate();
    if (problem) {
      setFormError(problem);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await locationNodesApi.adjust({
        lot_id: target.lot_id,
        node_id: target.node_id,
        direction,
        qty: effectiveQty,
        // A box names positions; a flat location names none. The two keys are
        // shaped differently on purpose — see `cellKey` in the grid picker.
        cells:
          isGrid && direction === 'in'
            ? cellKeys.map((k) => {
                const [row, col] = k.split(':');
                return { grid_row: Number(row), grid_col: Number(col) };
              })
            : undefined,
        cell_allocation_ids: isGrid && direction === 'out' ? cellKeys : undefined,
        evidence_id: evidence.evidence_id,
        // Optional on every e-signature (client 2026-06-29) — sent only when
        // the operator wrote one, so the ledger note stays clean without it.
        notes: evidence.comment?.trim() || null,
      });
      toast.success(
        `${direction === 'in' ? 'Added' : 'Removed'} ${formatNumber(effectiveQty)}`,
        { description: `${target.location} now holds ${formatNumber(result.qty_at_node)}.` },
      );
      onDone();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : 'Could not adjust. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const meaning = target
    ? `I am correcting the recorded quantity of lot ${
        target.lot_number ?? target.lot_id.slice(0, 8)
      } at ${target.location}: ${direction === 'in' ? 'adding' : 'removing'} ${
        effectiveQty || 0
      }.`
    : '';

  /** What the location will hold once this posts. Shown only while the numbers
   *  make sense, so it never advertises a total the server would reject — the
   *  point of it is that the operator recognises the count they just made
   *  before they sign, not after. */
  const preview =
    target && Number.isInteger(effectiveQty) && effectiveQty > 0
      ? direction === 'in'
        ? target.qty + effectiveQty
        : target.qty - effectiveQty
      : null;
  const previewValid = preview !== null && preview >= 0;

  const fields = (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>Direction</Label>
        <SegmentedControl
          options={DIRECTIONS}
          value={direction}
          onChange={onDirectionChange}
          aria-label="Adjust stock in or out"
        />
      </div>

      {isGrid ? (
        <div className="space-y-1.5">
          <Label>
            {direction === 'out' ? 'Vials to remove' : 'Positions to fill'}
          </Label>
          {grid.loading && !grid.grid ? (
            <p className="text-xs text-text-3">Loading positions…</p>
          ) : grid.grid ? (
            <CellGridPicker
              mode={direction === 'out' ? 'source' : 'destination'}
              rows={grid.grid.rows}
              cols={grid.grid.cols}
              cells={direction === 'out' ? lotCells : grid.grid.cells}
              value={cellKeys}
              onChange={setCellKeys}
              disabled={submitting}
            />
          ) : (
            <p className="text-xs text-danger">
              Could not load this box&rsquo;s positions.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="stock-adjust-qty">
            Quantity to {direction === 'out' ? 'remove' : 'add'}
          </Label>
          <Input
            id="stock-adjust-qty"
            type="number"
            inputMode="numeric"
            step="1"
            min={1}
            max={direction === 'out' ? target?.qty : undefined}
            value={qty}
            disabled={submitting}
            onChange={(e) => setQty(e.target.value)}
          />
        </div>
      )}

      {/* The arithmetic, done for the operator. A correction is the one place
          where the number that matters is the one they are NOT typing. */}
      <div className="flex items-baseline justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
        <span className="text-xs text-text-2">After this correction</span>
        {previewValid ? (
          <span className="flex items-baseline gap-2">
            <span className="text-xs text-text-3 line-through">
              {formatNumber(target?.qty ?? 0)}
            </span>
            <span className="text-base font-semibold tabular-nums text-text-1">
              {formatNumber(preview)}
            </span>
            <span
              className={
                direction === 'in'
                  ? 'text-xs tabular-nums text-success'
                  : 'text-xs tabular-nums text-warning'
              }
            >
              {direction === 'in' ? '+' : '−'}
              {formatNumber(effectiveQty)}
            </span>
          </span>
        ) : (
          <span className="text-xs tabular-nums text-text-3">
            {formatNumber(target?.qty ?? 0)} · unchanged
          </span>
        )}
      </div>

      {formError && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
        >
          {formError}
        </p>
      )}
    </div>
  );

  const reauth = (
    <PasswordReauthDialog
      open={showReauth}
      onOpenChange={setShowReauth}
      action="movement.adjustment"
      recordTable="app.lots"
      recordId={target?.lot_id ?? undefined}
      meaning={meaning}
      commentPlaceholder={
        direction === 'out'
          ? 'e.g. Cycle count — two vials broken in handling'
          : 'e.g. Cycle count — three vials found unrecorded'
      }
      onConfirmed={submit}
      title="Sign this adjustment"
      submitLabel="Sign & save"
    />
  );

  return { fields, reauth, openSign, submitting };
}

interface Props {
  target: AdjustTarget | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

/**
 * The standalone correction dialog, opened from a row on "Stock by location".
 *
 * The Edit lot dialog does NOT use this — it cannot stack a dialog on itself,
 * so it renders {@link useStockAdjust}'s pieces as a view of its own.
 */
export function StockAdjustDialog({ target, onOpenChange, onDone }: Props) {
  const open = target !== null;
  const adjust = useStockAdjust({
    target,
    onDone: () => {
      onDone();
      onOpenChange(false);
    },
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Adjust stock</DialogTitle>
            <DialogDescription>
              {target ? (
                <>
                  <span className="font-mono text-accent">
                    {target.lot_number ?? target.lot_id.slice(0, 8)}
                  </span>{' '}
                  at {target.location} · recorded {formatNumber(target.qty)}. Corrects
                  what is here, not what was received. Recorded under your
                  e-signature.
                </>
              ) : (
                'Loading…'
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogBody>{adjust.fields}</DialogBody>

          <DialogFooter>
            <Button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={adjust.submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={adjust.openSign}
              disabled={adjust.submitting || !target}
            >
              <Scale size={14} /> Sign &amp; save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {adjust.reauth}
    </>
  );
}
