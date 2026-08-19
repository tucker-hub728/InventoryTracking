import { cn } from '@/lib/utils';
import { RELEASE_STATE_LABEL, type LotReleaseState } from '@/lib/api/lots';

/**
 * A batch's release state (REQ-2026-07-31-STS-001).
 *
 * Renders NOTHING for a null state. Most lots in the system are consumables and
 * raw materials with no release workflow at all, and stamping them "n/a" would
 * put a badge on almost every row to say nothing. Callers can therefore drop
 * this in unconditionally next to any lot number.
 *
 * The four colours reuse the app's semantic tokens rather than inventing a
 * palette: held is a warning, cleared is a success, failed is a danger, and
 * "under review" borrows the accent because it is the one state that means work
 * is actively happening. Never colour alone — the label is always spelled out.
 */
export function ReleaseStateBadge({
  state,
  size = 'sm',
  className,
}: {
  state: LotReleaseState | null | undefined;
  /** ``xs`` for dense rows (a box's contents list), ``sm`` everywhere else. */
  size?: 'xs' | 'sm';
  className?: string;
}) {
  if (!state) return null;

  return (
    <span
      // A tooltip, because in a dense list the badge is often the only hint
      // that a release workflow applies to this row at all.
      title={`Quality status: ${RELEASE_STATE_LABEL[state]}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border font-medium',
        size === 'xs' ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-[11px]',
        TONE[state],
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {RELEASE_STATE_LABEL[state]}
    </span>
  );
}

const TONE: Record<LotReleaseState, string> = {
  quarantine: 'border-warning/40 bg-warning/10 text-warning',
  qc_hold: 'border-accent/40 bg-accent/10 text-accent',
  released: 'border-success/40 bg-success/10 text-success',
  rejected: 'border-danger/40 bg-danger/10 text-danger',
};
