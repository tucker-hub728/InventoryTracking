'use client';

import * as React from 'react';
import { ShieldCheck } from 'lucide-react';

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
  /** Sentence the user is attesting to — rendered verbatim. */
  meaning: string;
  /** Called with the fresh evidence id when the password verifies. */
  onConfirmed: (evidence: ReauthResponse) => void;
  /** Headline above the password field. Defaults to "Confirm your password". */
  title?: string;
  /** Submit-button label. Defaults to "Sign". */
  submitLabel?: string;
  /**
   * Placeholder for the mandatory comment/reason field, so each flow can
   * prompt for the right kind of rationale (e.g. "Reason for this
   * placement"). The field itself is always required.
   */
  commentPlaceholder?: string;
}

/**
 * Reusable e-signature dialog. The user types their password to mint a
 * single-use evidence id that the caller passes to the write endpoint, and
 * a mandatory reason/comment recorded with it. Every GxP-significant write
 * flow (receipts, dispenses, adjustments, transfers, lot edits, forecast
 * saves) uses this exact dialog so the experience is identical across the
 * system — a 21 CFR Part 11 expectation (consistent identity-verification UX).
 *
 * The signature is the *electronic* signature: the password re-auth plus the
 * recorded rationale, attributed in the audit trail to the signed-in user with
 * a timestamp. There is no hand-drawn signature step.
 */
export function PasswordReauthDialog({
  open,
  onOpenChange,
  action,
  meaning,
  onConfirmed,
  title = 'Confirm your password',
  submitLabel = 'Sign',
  commentPlaceholder = 'e.g. correcting an erroneous transfer',
}: Props) {
  const { reauth, pending, error, rateLimited, reset } = useReauth(action);
  const [password, setPassword] = React.useState('');
  // Mandatory rationale for the action — recorded on the e-signature row
  // and surfaced on the audit log (21 CFR Part 11).
  const [comment, setComment] = React.useState('');

  // Wipe state every time the dialog closes so a re-open starts clean.
  React.useEffect(() => {
    if (!open) {
      setPassword('');
      setComment('');
      reset();
    }
  }, [open, reset]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!password) return;
    if (!comment.trim()) return;

    const evidence = await reauth({
      password,
      meaning,
      comment: comment.trim(),
    });
    if (evidence) {
      onConfirmed(evidence);
      onOpenChange(false);
    }
  };

  const submitDisabled =
    pending || rateLimited || !password || !comment.trim();

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
            {/* The attestation text. Rendered as a quote so the user
                clearly sees what they're signing. */}
            <blockquote className="rounded-md border border-border bg-surface px-3 py-2.5 text-xs italic text-text-2">
              {meaning}
            </blockquote>

            <div className="space-y-1.5">
              <Label htmlFor="reauth-comment">
                Reason / comment <span className="text-danger">*</span>
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
                type="password"
                autoComplete="current-password"
                disabled={pending || rateLimited}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={Boolean(error)}
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
