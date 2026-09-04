'use client';

import * as React from 'react';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';

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
import { Textarea } from '@/components/ui/textarea';
import { useReauth } from '@/hooks/use-reauth';
import type { ReauthResponse } from '@/lib/api/auth';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stable, machine-readable verb the backend will check against. */
  action: string;
  /**
   * The record being signed for — e.g. `'app.lots'` and the lot's id.
   *
   * The backend binds the signature to this and refuses to spend it on
   * anything else, so a ticket minted on one record cannot be used to
   * authorise a change to another (VR-006). Pass what the operator is
   * actually looking at.
   *
   * Omit ONLY where no record exists yet — creating a top-level tier, or the
   * forecast grid save, which spans many records at once. Every other caller
   * should supply it; leaving it out silently weakens the signature to
   * "some record of this type".
   */
  recordTable?: string;
  recordId?: string;
  /** Sentence the user is attesting to — rendered verbatim. */
  meaning: string;
  /**
   * Optional control rendered above the attestation, for an action whose ONLY
   * input is the thing being signed for — the quantity on a Kanban
   * acknowledgment, say. It exists so such a flow is one dialog rather than a
   * form followed by a signature, which is two steps for one decision.
   *
   * The caller keeps ``meaning`` in step with whatever is typed here; the
   * sentence quotes the value, so a stale one would attest to a number the
   * operator did not enter.
   */
  fields?: React.ReactNode;
  /**
   * Block signing while whatever is in ``fields`` is incomplete.
   *
   * Not cosmetic. Evidence is minted by the server the moment the password
   * verifies, and it is single-use and bound to a record — so a caller that
   * validated only in its own handler would burn a real signature on a form it
   * then refused to submit, and the operator would be told to "sign again"
   * for a mistake the dialog could see.
   */
  fieldsInvalid?: boolean;
  /** Called with the fresh evidence id when the password verifies. */
  onConfirmed: (evidence: ReauthResponse) => void;
  /** Headline above the password field. Defaults to "Confirm your password". */
  title?: string;
  /** Submit-button label. Defaults to "Sign". */
  submitLabel?: string;
  /**
   * Placeholder for the comment/reason field, so each flow can prompt for the
   * right kind of rationale (e.g. "Reason for this placement").
   */
  commentPlaceholder?: string;
}

/**
 * Reusable e-signature dialog. The user types their password to mint a
 * single-use evidence id that the caller passes to the write endpoint, plus an
 * optional reason/comment recorded with it. Every GxP-significant write flow
 * (receipts, dispenses, adjustments, transfers, lot edits, forecast saves) uses
 * this exact dialog so the experience is identical across the system — a 21 CFR
 * Part 11 expectation (consistent identity-verification UX).
 *
 * The reason/comment is **always optional** (client directive, 2026-07-01 — no
 * e-signature requires a comment): whatever the operator provides is recorded,
 * a blank is fine.
 *
 * The signature is the *electronic* signature: the password re-auth plus the
 * recorded rationale, attributed in the audit trail to the signed-in user with
 * a timestamp. There is no hand-drawn signature step.
 */
export function PasswordReauthDialog({
  open,
  onOpenChange,
  action,
  recordTable,
  recordId,
  meaning,
  fields,
  fieldsInvalid = false,
  onConfirmed,
  title = 'Confirm your password',
  submitLabel = 'Sign',
  commentPlaceholder = 'e.g. correcting an erroneous transfer',
}: Props) {
  const { reauth, pending, error, rateLimited, reset } = useReauth(action);
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  // Optional rationale for the action — recorded on the e-signature row and
  // surfaced on the audit log. Never required.
  const [comment, setComment] = React.useState('');

  // Wipe state every time the dialog closes so a re-open starts clean.
  React.useEffect(() => {
    if (!open) {
      setPassword('');
      setShowPassword(false);
      setComment('');
      reset();
    }
  }, [open, reset]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!password) return;

    const evidence = await reauth({
      password,
      meaning,
      comment: comment.trim() || undefined,
      recordTable,
      recordId,
    });
    if (evidence) {
      onConfirmed(evidence);
      onOpenChange(false);
    }
  };

  const submitDisabled = pending || rateLimited || !password || fieldsInvalid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              <span className="flex items-start gap-2 text-text-2">
                <ShieldCheck
                  size={14}
                  aria-hidden
                  className="mt-0.5 flex-none text-accent"
                />
                <span>
                  21 CFR Part 11 — your password authorises this action
                  and is recorded in the audit trail.
                </span>
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {/* One field the signature is ABOUT, when the action has exactly
                one and asking for it separately would mean two dialogs for one
                decision. Rendered ABOVE the attestation deliberately: the
                sentence being signed quotes this value, so it has to be
                settled before it is read, not after.

                Kept to a slot rather than a prop so callers own the label and
                validation, and deliberately NOT a general form area — anything
                needing more than one field is a step of its own before this
                one, or the operator is reading an attestation about values
                still scrolling past underneath it. */}
            {fields}

            {/* The attestation text. Rendered as a quote so the user
                clearly sees what they're signing. */}
            <blockquote className="rounded-md border border-border bg-surface px-3 py-2.5 text-xs italic text-text-2">
              {meaning}
            </blockquote>

            <div className="space-y-1.5">
              <Label htmlFor="reauth-comment">
                Reason / comment{' '}
                <span className="font-normal text-text-3">(optional)</span>
              </Label>
              <Textarea
                id="reauth-comment"
                rows={2}
                autoFocus
                placeholder={commentPlaceholder}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                disabled={pending || rateLimited}
              />
              <p className="text-[11px] text-text-3">
                Recorded with your signature on the audit log.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reauth-password">
                Password <span className="text-danger">*</span>
              </Label>
              <Input
                id="reauth-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                disabled={pending || rateLimited}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={Boolean(error)}
                trailing={
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    disabled={pending || rateLimited}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    tabIndex={-1}
                    className="flex-none rounded-sm p-0.5 text-text-3 transition-colors hover:text-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {showPassword ? (
                      <EyeOff size={14} aria-hidden />
                    ) : (
                      <Eye size={14} aria-hidden />
                    )}
                  </button>
                }
              />
            </div>

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
            <Button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitDisabled}>
              {pending ? 'Verifying…' : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
