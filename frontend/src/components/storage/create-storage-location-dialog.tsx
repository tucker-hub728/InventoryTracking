'use client';

/**
 * Create one storage location (LOC-001).
 *
 * ONE question: its name. The location is created bare — its shelves,
 * refrigerators and freezers are added afterwards from "Configure sub-types" on
 * the location itself.
 *
 * Two things this dialog used to ask and no longer does:
 *
 *  * **Three sub-type switches** (Shelf / Refrigerator / Freezer). LOC-001 makes
 *    sub-types configurable after creation, so ONE screen should decide them —
 *    asking here made two, with two sets of copy to keep in step. The switch form
 *    also could not express what the amended requirement is FOR: a location with
 *    two freezers. Anyone needing one had to create the location and then go and
 *    reconfigure it anyway.
 *
 *  * **Normal storage vs debit-and-gone.** Debit-and-gone locations have their own
 *    section now (``/debit-and-gone``) with their own create dialog, so this page
 *    creates the one kind of thing it is about. That radio decided an IMMUTABLE
 *    property — the server refuses to change ``is_scrap`` afterwards — from a
 *    control you could hit by accident on a page about the other kind of place,
 *    and the result could never be converted. See
 *    ``components/debit-and-gone/create-location-dialog.tsx``.
 *
 * So this dialog never sends ``is_scrap``; the API defaults it to false.
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
  /** Names already used anywhere in the room — including the debit-and-gone
   *  locations, which are siblings in the tree. Checked client-side so the
   *  obvious mistake costs no round trip; the server checks too. */
  existingNames: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = React.useState('');
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
      setError(`“${v}” is already a location.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.createStorageCategory({ name: v });
      // Receipt Admin and kitting cache the destination tree for the session, so
      // a new location is invisible to those pickers until the cache is dropped.
      // Every mutation of the location structure has to do this.
      invalidateLocationForest();
      toast.success('Location created', {
        description: `${v} — add its sub-types from the ⋯ menu`,
      });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'node_name_conflict') {
        setError(`“${v}” is already a location.`);
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

          {/* What happens NEXT. The location arrives with no tabs, which is a
              surprise worth pre-empting here rather than letting the empty page
              deliver it — the next action is one click away and this says so. */}
          <div className="rounded-lg border border-border bg-surface/50 px-3 py-2.5">
            <p className="text-xs font-medium text-text-2">Sub-types come next</p>
            <p className="mt-0.5 text-xs text-text-3">
              The location starts empty. Add its shelves, refrigerators and freezers from
              “Configure sub-types” on the location — as many of each as it has, named the
              way they are labelled in the room.
            </p>
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
