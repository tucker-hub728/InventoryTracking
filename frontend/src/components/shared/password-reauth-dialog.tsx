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
import { useReauth } from '@/hooks/use-reauth';
import type { ReauthResponse } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/client';
import { uploadSignature } from '@/lib/api/uploads';
import {
  SignaturePad,
  type SignaturePadHandle,
} from '@/components/shared/signature-pad';

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
   * Whether a hand-drawn signature is required. ``true`` blocks submit
   * until the canvas has a stroke; ``false`` shows the pad as optional
   * (omitted from the upload if untouched). Defaults to ``true``
   * — the standard Part 11 ceremony.
   */
  signatureRequired?: boolean;
}

/**
 * Reusable e-signature dialog. The user types their password to mint
 * a single-use evidence id that the caller passes to the write
 * endpoint. Every GxP-significant write flow (receipts, dispenses,
 * adjustments, transfers, discards) uses this exact dialog so the
 * user experience is identical across the system — that's also a
 * 21 CFR Part 11 expectation (consistent identity-verification UX).
 */
export function PasswordReauthDialog({
  open,
  onOpenChange,
  action,
  meaning,
  onConfirmed,
  title = 'Confirm your password',
  submitLabel = 'Sign',
  signatureRequired = true,
}: Props) {
  const { reauth, pending, error, rateLimited, reset } = useReauth(action);
  const [password, setPassword] = React.useState('');
  const padRef = React.useRef<SignaturePadHandle | null>(null);
  // Local "first stroke recorded" flag — Pad's ``isEmpty()`` is a ref
  // so it doesn't trigger a re-render. We mirror it in state to drive
  // the submit-disabled gate without polling.
  const [hasSigned, setHasSigned] = React.useState(false);
  // Surfaced separately from the password error so we can colour each
  // field appropriately when both fail at once.
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);

  // Wipe state every time the dialog closes so a re-open starts clean.
  React.useEffect(() => {
    if (!open) {
      setPassword('');
      setHasSigned(false);
      setUploadError(null);
      setUploading(false);
      padRef.current?.clear();
      reset();
    }
  }, [open, reset]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!password) return;
    if (signatureRequired && !hasSigned) return;

    // 1) If the canvas has a drawing, upload it first to get the S3
    //    key. Done before the reauth call so a single failure path
    //    (upload | password) keeps the audit row consistent.
    let signatureKey: string | undefined;
    setUploadError(null);
    const blob = await padRef.current?.toBlob();
    if (blob) {
      setUploading(true);
      try {
        const uploaded = await uploadSignature(blob);
        signatureKey = uploaded.key;
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.message
            : 'Could not upload signature image.';
        setUploadError(msg);
        setUploading(false);
        return;
      } finally {
        setUploading(false);
      }
    }

    // 2) Reauth with (optional) signature key attached to the audit row.
    const evidence = await reauth({
      password,
      meaning,
      signatureImageS3Key: signatureKey,
    });
    if (evidence) {
      onConfirmed(evidence);
      onOpenChange(false);
    }
  };

  const submitDisabled =
    pending ||
    uploading ||
    rateLimited ||
    !password ||
    (signatureRequired && !hasSigned);

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
              <Label>
                Hand-drawn signature{' '}
                {signatureRequired && <span className="text-danger">*</span>}
              </Label>
              <SignaturePad
                ref={padRef}
                onFirstStroke={() => setHasSigned(true)}
                onChange={(d) => {
                  // ``onChange('')`` fires on clear — sync state back.
                  if (!d) setHasSigned(false);
                }}
                height={140}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reauth-password">
                Password <span className="text-danger">*</span>
              </Label>
              <Input
                id="reauth-password"
                type="password"
                autoComplete="current-password"
                disabled={pending || uploading || rateLimited}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={Boolean(error)}
              />
            </div>

            {uploadError && (
              <p
                role="alert"
                className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
              >
                {uploadError}
              </p>
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
            <Button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={pending || uploading}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitDisabled}>
              {uploading
                ? 'Uploading…'
                : pending
                  ? 'Verifying…'
                  : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
