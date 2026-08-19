'use client';

/**
 * Create one debit-and-gone location (REQ-2026-08-04-TRX-001/002).
 *
 * Name it. That is the whole form — this page only makes one kind of thing, so
 * there is nothing to choose.
 *
 * It replaced a radio on the Storage create dialog that asked "normal storage or
 * debit-and-gone?". That question decided an IMMUTABLE property from a control
 * you could hit by accident, on a page about the other kind of place, and the
 * resulting location could never be converted. Splitting the two creates means
 * each page makes the thing it is about and the mistake is unavailable.
 *
 * What this flag actually does: it makes the location a legal ISSUE destination.
 * Material issued here leaves controlled inventory permanently. The location
 * stores nothing and takes no sub-types — the server refuses to add one.
 *
 * Super-Admin-only, same governance as every other location write (LOC-004).
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

export function CreateDebitAndGoneLocationDialog({
  existingNames,
  onClose,
  onDone,
}: {
  /** Names already used anywhere in Storage — a debit-and-gone location is a
   *  sibling of the storage ones in the tree, so it competes for the same names.
   *  Checked here so the obvious mistake costs no round trip; the server checks
   *  too and is the authority. */
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
      await locationNodesApi.createStorageCategory({ name: v, is_scrap: true });
      // Receipt Admin, kitting and the Issue dialog cache the destination tree
      // for the session, so a new location is invisible to those pickers until
      // the cache is dropped. Every mutation of the location structure does this.
      invalidateLocationForest();
      toast.success('Location created', {
        description: `${v} — material issued here leaves inventory`,
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
          <DialogTitle>Create debit-and-gone location</DialogTitle>
          <DialogDescription>
            Somewhere material is sent to be used up — a PD or R&amp;D lab, QC, scrap.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="disposition-location-name">Name</Label>
            <Input
              id="disposition-location-name"
              autoFocus
              maxLength={128}
              placeholder="e.g. QC Lab"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void submit();
              }}
            />
          </div>

          {/* Stated before the button, not after the fact. Everything here is
              irreversible in a way an operator cannot see from the location's
              own page later, so the consequence belongs at the point of choice. */}
          <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5">
            <p className="text-xs font-medium text-text-2">
              Material issued here leaves inventory
            </p>
            <p className="mt-0.5 text-xs text-text-3">
              Permanently, and it cannot be returned. The location stores nothing — it has no
              shelves, refrigerators or freezers, and its page shows what has been issued to
              it. This cannot be changed after the location is created.
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
