import { AlertTriangle } from 'lucide-react';

/**
 * A heads-up that stock about to move is a Rejected batch (STS-003, client
 * 2026-08-17: "it would be good to alert the user that they are trying to
 * transfer a rejected product").
 *
 * A WARNING, never a block. The client was explicit that Product Development
 * routinely consumes rejects — when the reason for rejection is irrelevant to
 * the test being run, a rejected batch is exactly the right material to use. So
 * this informs and gets out of the way; the submit button stays enabled and no
 * validation depends on it.
 *
 * Renders nothing when no rejected batch is in play, which is almost always.
 */
export function RejectedLotWarning({
  lotNumbers,
  action,
}: {
  /** Lot numbers of the rejected batches among the current selection. */
  lotNumbers: string[];
  /** The verb, for the sentence — e.g. "transfer", "ship". */
  action: string;
}) {
  if (lotNumbers.length === 0) return null;
  const one = lotNumbers.length === 1;
  return (
    // ``status`` not ``alert``: this is advisory, and an assertive live region
    // would interrupt a screen-reader user mid-selection for something they are
    // very likely doing on purpose.
    <p
      role="status"
      className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning"
    >
      <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden />
      <span>
        {one ? 'Lot ' : 'Lots '}
        <span className="font-mono">{lotNumbers.join(', ')}</span>{' '}
        {one ? 'is' : 'are'} marked <strong>Rejected</strong>. You can still {action} —
        this is a heads-up, not a block.
      </span>
    </p>
  );
}
