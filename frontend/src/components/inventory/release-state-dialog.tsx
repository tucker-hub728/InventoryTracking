'use client';

import * as React from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';

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
import { Label } from '@/components/ui/label';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '@/components/ui/searchable-select';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { ReleaseDecisionHistory } from '@/components/inventory/release-decision-history';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import {
  lotsApi,
  RELEASE_STATE_LABEL,
  RELEASE_STATE_OPTIONS,
  type LotReleaseState,
} from '@/lib/api/lots';

import { ReleaseStateBadge } from './release-state-badge';

/** The signing verb. Its own, not ``lot.update``: a ticket minted to correct an
 *  expiry date must never be spendable on releasing a batch (STS-002). */
export const RELEASE_STATE_ACTION = 'lot.release_state';

/** A batch this dialog may act on. */
export interface ReleaseLotChoice {
  id: string;
  lot_number: string;
  release_state: LotReleaseState | null;
  /** Where it sits, or anything else that tells two lots apart in the picker. */
  hint?: string | null;
}

/**
 * Move a batch between quarantine / QC hold / released / rejected
 * (REQ-2026-07-31-STS-002).
 *
 * Takes a LIST of candidate lots rather than one, because the useful entry
 * point is "I want to release something here" — from an item's header, or a
 * box's — not "I have already found the exact row". With one candidate it goes
 * straight to the decision; with several it asks which batch first. The
 * per-row buttons pass a single-element list and see no picker.
 *
 * Every transition is offered — no state is terminal, including ``rejected``
 * (client 2026-08-17). The only option withheld is the one the lot is already
 * in, because signing a change that changes nothing would put a meaningless
 * attestation in the permanent record; the backend rejects it too.
 *
 * The dialog states plainly that this is a label, so nobody signs it believing
 * they have just stopped the material from being shipped.
 */
export function ReleaseStateDialog({
  open,
  onOpenChange,
  lots,
  scopeLabel,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Release-tracked batches in scope. Empty is a legitimate state — an item or
   *  box holding nothing but consumables has no release decisions to make. */
  lots: ReleaseLotChoice[];
  /** Where the list came from, e.g. "box 1" — used in the empty state. */
  scopeLabel?: string;
  onDone: () => void;
}) {
  const [lotId, setLotId] = React.useState<string | null>(null);
  const [choice, setChoice] = React.useState<LotReleaseState | null>(null);
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const only = lots.length === 1 ? lots[0]! : null;

  React.useEffect(() => {
    if (!open) return;
    // One candidate needs no choosing; several start unpicked so nothing is
    // decided by accident.
    setLotId(only?.id ?? null);
    setChoice(null);
    setShowReauth(false);
    setSubmitting(false);
    setError(null);
  }, [open, only?.id, lots.length]);

  const lot = lots.find((l) => l.id === lotId) ?? null;
  const current = lot?.release_state ?? null;
  const options = RELEASE_STATE_OPTIONS.filter((o) => o.code !== current);

  // Each option carries the lot number, where it sits, and its current state,
  // so the choice can be made without closing the dropdown to check.
  const lotOptions: SearchableSelectOption[] = React.useMemo(
    () =>
      lots.map((l) => ({
        value: l.id,
        // ONE line: this same node renders inside the 32px-tall trigger as
        // well as in the list, and a stacked label would be clipped there.
        label: (
          <span className="flex w-full items-center gap-2">
            <span className="shrink-0 font-mono text-xs text-text">{l.lot_number}</span>
            {l.hint && (
              <span className="min-w-0 flex-1 truncate text-[11px] text-text-3">{l.hint}</span>
            )}
            <span className="ml-auto shrink-0">
              <ReleaseStateBadge state={l.release_state} size="xs" />
            </span>
          </span>
        ),
        // Both, because "the one in box 1" is how an operator names a batch.
        searchText: `${l.lot_number} ${l.hint ?? ''}`,
      })),
    [lots],
  );

  const submit = async (evidence: ReauthResponse) => {
    if (!lot || !choice) return;
    setSubmitting(true);
    setError(null);
    try {
      await lotsApi.setReleaseState(lot.id, {
        release_state: choice,
        evidence_id: evidence.evidence_id,
        reason: evidence.comment ?? null,
      });
      toast.success('Release state changed', {
        description: `${lot.lot_number} is now ${RELEASE_STATE_LABEL[choice]}.`,
      });
      onDone();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.code === 'reauth_evidence_replayed' || err.code === 'reauth_evidence_expired'
            ? 'Your signature expired or was already used. Sign again.'
            : err.message,
        );
      } else {
        setError('Could not change the release state. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Change release state</DialogTitle>
            <DialogDescription>
              {/* With one candidate the batch is a fact, so state it. With
                  several it is the first thing to choose, and repeating it here
                  would just contradict the picker below. */}
              {only ? (
                <>
                  Lot <span className="font-mono">{only.lot_number}</span> is currently{' '}
                  {current ? (
                    <ReleaseStateBadge state={current} className="align-middle" />
                  ) : (
                    <span className="text-text-2">not tracked</span>
                  )}
                  .
                </>
              ) : (
                'Choose the batch, then the state it moves to.'
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-3">
            {lots.length === 0 && (
              <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-text-3">
                Nothing here carries a release state
                {scopeLabel ? ` in ${scopeLabel}` : ''}. Only manufactured product does —
                consumables and raw materials have no release workflow.
              </p>
            )}

            {/* A dropdown rather than a stack of cards: a busy freezer can hold
                dozens of batches, and the house rule for a long picklist is
                SearchableSelect. Searchable on lot number AND location, since
                "the one in box 1" is how an operator thinks of it. Skipped
                entirely for a single candidate — there is nothing to pick. */}
            {lots.length > 1 && (
              <div className="space-y-1.5">
                <Label htmlFor="release-lot">Which batch</Label>
                <SearchableSelect
                  id="release-lot"
                  modal
                  options={lotOptions}
                  value={lotId ?? ''}
                  onChange={(v) => {
                    setLotId(v);
                    // The previous pick may be this lot's current state, which
                    // is not offered — clear it rather than leave it stale.
                    setChoice(null);
                    setError(null);
                  }}
                  placeholder="Select a batch…"
                  searchPlaceholder="Search lot or location…"
                  emptyText="No matching batch."
                />
              </div>
            )}

            {lot && (
              <div className="space-y-1.5">
                <Label>Move it to</Label>
                <div
                  role="radiogroup"
                  aria-label="New release state"
                  className="overflow-hidden rounded-md border border-border"
                >
                  {options.map((o, i) => {
                    const picked = choice === o.code;
                    return (
                      <button
                        key={o.code}
                        type="button"
                        role="radio"
                        aria-checked={picked}
                        onClick={() => {
                          setChoice(o.code);
                          setError(null);
                        }}
                        className={cn(
                          'flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors',
                          'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                          i > 0 && 'border-t border-border',
                          picked ? 'bg-accent/5' : 'hover:bg-surface',
                        )}
                      >
                        {/* A real radio dot, so the group reads as one choice
                            rather than three independent toggles. */}
                        <span
                          aria-hidden
                          className={cn(
                            'grid size-4 shrink-0 place-items-center rounded-full border transition-colors',
                            picked ? 'border-accent' : 'border-border-strong',
                          )}
                        >
                          {picked && <span className="size-2 rounded-full bg-accent" />}
                        </span>
                        <ReleaseStateBadge state={o.code} />
                        <span className="min-w-0 flex-1 text-xs text-text-3">{o.meaning}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* What the signature will actually attest to, spelled out — it is
                also exactly the before/after pair written to the audit record. */}
            {lot && choice && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs">
                <span className="font-mono text-text-2">{lot.lot_number}</span>
                {current ? (
                  <ReleaseStateBadge state={current} size="xs" />
                ) : (
                  <span className="text-text-3">not tracked</span>
                )}
                <ArrowRight size={13} className="text-text-3" aria-label="becomes" />
                <ReleaseStateBadge state={choice} size="xs" />
              </div>
            )}

            {/* The paper trail, in the dialog rather than on a separate screen:
                the question "what has already been decided about this batch"
                is one you ask WHILE deciding, not afterwards. Reads the audit
                store — there is no history table (STS-002). */}
            {lot && (
              <details className="rounded-md border border-border bg-surface/50">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs text-text-2 marker:text-text-3">
                  Decision history
                </summary>
                <div className="max-h-64 overflow-y-auto border-t border-border p-2">
                  <ReleaseDecisionHistory lotId={lot.id} />
                </div>
              </details>
            )}

            {error && (
              <p
                role="alert"
                className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
              >
                {error}
              </p>
            )}
          </DialogBody>

          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={!lot || !choice || submitting}
              onClick={() => setShowReauth(true)}
            >
              <ShieldCheck size={14} /> Sign &amp; change
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action={RELEASE_STATE_ACTION}
        // The signature is ABOUT the lot — the batch whose disposition is being
        // decided — which is also the row the change lands on.
        recordTable="app.lots"
        recordId={lot?.id}
        meaning={
          choice
            ? `I am changing the release state of lot ${lot?.lot_number} from ${
                current ? RELEASE_STATE_LABEL[current] : 'none'
              } to ${RELEASE_STATE_LABEL[choice]}.`
            : ''
        }
        commentPlaceholder="e.g. COA-4471 passed, sterility clear"
        onConfirmed={submit}
        title="Sign this decision"
        submitLabel="Sign & change"
      />
    </>
  );
}
