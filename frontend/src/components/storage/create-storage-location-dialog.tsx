'use client';

/**
 * Create one location in Storage (LOC-001).
 *
 * Two questions only: its name, and what happens to material sent there. The
 * location is created with NO sub-types; they are added from "Configure
 * sub-types" on the location itself.
 *
 * This dialog used to carry three switches — Shelf, Refrigerator, Freezer — and
 * provision the ones left on. They were removed on 2026-08-19. LOC-001 makes
 * sub-types configurable after creation, so ONE screen should decide them, and
 * asking here made two: the same question in two places, with two sets of copy
 * to keep in step. Worse, the switch form could not express what the amended
 * requirement is FOR — a location with two freezers — so anyone who needed one
 * had to create the location, then go and reconfigure it anyway.
 *
 * The **debit-and-gone** choice (REQ-2026-08-04-TRX-001/002) is the opposite: it
 * IS frozen at creation, because it changes what a transaction to this place
 * MEANS. Turning it on later would leave stock sitting somewhere now supposed to
 * consume everything sent to it; turning it off would imply already-issued
 * material has a home. So it is asked here, once, and the server refuses to
 * change it afterwards.
 *
 * Note what the choice does NOT do: a scrap location is still an ordinary
 * location. It may carry shelves, refrigerators and freezers, and stock can be
 * TRANSFERRED into those and stay tracked. What the flag adds is that the
 * location itself becomes a legal ISSUE destination — and issuing is what
 * removes material from inventory.
 *
 * Super-Admin-only (LOC-004). The API enforces it; the caller decides whether to
 * render the control at all.
 */

import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/sonner';
import { invalidateLocationForest } from '@/components/reconciliation/location-tree-picker';
import { ApiError } from '@/lib/api/client';
import { locationNodesApi } from '@/lib/api/location-nodes';

export function CreateStorageLocationDialog({
  existingNames,
  onClose,
  onDone,
}: {
  /** Names already used in Storage — checked client-side so the obvious mistake
   *  is caught before a round trip. The server checks too. */
  existingNames: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = React.useState('');
  const [isScrap, setIsScrap] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const taken = React.useMemo(
    () => new Set(existingNames.map((n) => n.trim().toLowerCase())),
    [existingNames],
  );

  const submit = async () => {
    const v = name.trim();
    if (!v) {
      setError('Name is required.');
      return;
    }
    if (taken.has(v.toLowerCase())) {
      setError(`“${v}” is already a location in Storage.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.createStorageCategory({ name: v, is_scrap: isScrap });
      // Receipt Admin and kitting cache the destination tree for the session, so
      // a new location is invisible to those pickers until the cache is dropped.
      // Every mutation of the location structure has to do this.
      invalidateLocationForest();
      toast.success('Location created', {
        description: isScrap
          ? `${v} — material issued here leaves inventory`
          : `${v} — add its sub-types from the ⋯ menu`,
      });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'node_name_conflict') {
        setError(`“${v}” is already a location in Storage.`);
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to create the location.');
      }
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create new location</DialogTitle>
          <DialogDescription>
            A place inside Storage — for example “Materials Management”. Its shelves,
            refrigerators and freezers are added afterwards.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="storage-location-name">Name</Label>
            <Input
              id="storage-location-name"
              autoFocus
              maxLength={128}
              placeholder="e.g. Materials Management"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void submit();
              }}
            />
          </div>

          {/* The debit-and-gone choice (REQ-2026-08-04-TRX-001/002). Two radio
              options rather than one checkbox: this is not a modifier on a
              normal location, it is a decision about what a transaction here
              means, and stating both outcomes side by side is what makes the
              consequence legible before it is frozen.

              Named for the KIND of location, with the consequence underneath —
              "Debit-and-gone" is the term the app uses everywhere else,
              including the badge on the location itself, so the choice made
              here and the label seen afterwards read as the same thing.

              No lab names in the copy. The operator names the location: it may
              be R&D, Scrap, QC or anything else, and listing three examples as
              though they were the options invites the reading that nothing else
              qualifies. */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-text-2">Material sent to this location</p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {[
                {
                  scrap: false,
                  title: 'Normal storage',
                  hint: 'Stays in inventory. Stock transferred here is still tracked, in the shelf, refrigerator or freezer it goes to.',
                },
                {
                  scrap: true,
                  title: 'Debit-and-gone',
                  hint: 'Leaves inventory when issued. Material issued here is removed from inventory permanently and cannot be returned. Stock can still be transferred into its shelves and freezers and stays tracked — only issuing ends it.',
                },
              ].map((opt) => (
                <li key={String(opt.scrap)}>
                  <label
                    className="flex cursor-pointer items-start gap-3 px-3 py-2.5"
                    htmlFor={`storage-disposition-${opt.scrap}`}
                  >
                    <input
                      id={`storage-disposition-${opt.scrap}`}
                      type="radio"
                      name="storage-disposition"
                      className="mt-0.5 accent-accent"
                      checked={isScrap === opt.scrap}
                      onChange={() => setIsScrap(opt.scrap)}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm text-text">{opt.title}</span>
                      <span className="text-xs text-text-3">{opt.hint}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {isScrap && (
              <p className="text-xs text-warning">
                This cannot be changed after the location is created.
              </p>
            )}
          </div>

          {/* What happens NEXT. The location arrives with no tabs, which is a
              surprise worth pre-empting here rather than letting the empty page
              deliver it — the next action is one click away and this says so.
              A debit-and-gone location stores nothing, so it is told the other
              story: an empty page is the correct end state for it. */}
          <div className="rounded-lg border border-border bg-surface/50 px-3 py-2.5">
            {isScrap ? (
              <>
                <p className="text-xs font-medium text-text-2">No shelves, fridges or freezers</p>
                <p className="mt-0.5 text-xs text-text-3">
                  Nothing is stored at a debit-and-gone location, so it needs nowhere to put
                  stock. Its page shows what has been issued here instead. You can still add
                  sub-types later if material is transferred in.
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-medium text-text-2">Sub-types come next</p>
                <p className="mt-0.5 text-xs text-text-3">
                  The location starts empty. Add its shelves, refrigerators and freezers from
                  “Configure sub-types” on the location — as many of each as it has, named the
                  way they are labelled in the room.
                </p>
              </>
            )}
          </div>

          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
