'use client';

/**
 * Create one location from the standard template (REQ-2026-08-04-LOC-001).
 *
 * Name it, choose what happens to material sent there, then switch on the
 * sub-types it uses. All three sub-types start ON: the requirement provisions a
 * location with all three, and leaving one out is the exception rather than the
 * rule. A switched-off sub-type is simply not created — "a location without a
 * given sub-type simply does not use it".
 *
 * The switches are not a setting stored against the location; each one that is
 * on becomes a real group node the client may rename afterwards. That is why
 * they can be changed later (the ⋯ menu on the location) rather than being
 * frozen at creation.
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
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { invalidateLocationForest } from '@/components/reconciliation/location-tree-picker';
import { ApiError } from '@/lib/api/client';
import { locationNodesApi } from '@/lib/api/location-nodes';

import { STORAGE_GROUPS } from './storage-groups';

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
  const [enabled, setEnabled] = React.useState<Record<string, boolean>>(
    () => Object.fromEntries(STORAGE_GROUPS.map((g) => [g.key, true])),
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const chosen = STORAGE_GROUPS.filter((g) => enabled[g.key]);
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
    // A scrap location may have none: the location IS the destination, so there
    // is nothing to put anywhere. Mirrors the server's own relaxation.
    if (chosen.length === 0 && !isScrap) {
      setError('Choose at least one sub-type — a location needs somewhere to put things.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.createStorageCategory({
        name: v,
        is_scrap: isScrap,
        ...Object.fromEntries(STORAGE_GROUPS.map((g) => [g.key, Boolean(enabled[g.key])])),
      });
      // Receipt Admin and kitting cache the destination tree for the session, so
      // a new location is invisible to those pickers until the cache is dropped.
      // Every mutation of the location structure has to do this.
      invalidateLocationForest();
      toast.success('Location created', {
        description: isScrap
          ? `${v} — material issued here leaves inventory`
          : `${v} — ${chosen.map((g) => g.defaultName).join(', ')}`,
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
            A place inside Storage — for example “Materials Management”. Choose the sub-types
            it uses; you can change them later.
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

          {/* Sub-types are what STORAGE needs — a shelf, a fridge, a freezer for
              stock to sit in. A debit-and-gone location stores nothing: the
              material's life ends when it is issued there. Offering to create
              three containers for it produced exactly the confusion of a page
              with three permanently empty tabs, so they are shown only for
              normal storage. */}
          {!isScrap ? (
            <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-text-2">
              Sub-types this location uses
              {isScrap && <span className="font-normal text-text-3"> (optional)</span>}
            </p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {STORAGE_GROUPS.map((g) => {
                const Icon = g.icon;
                const on = Boolean(enabled[g.key]);
                return (
                  <li key={g.key} className="flex items-center gap-3 px-3 py-2.5">
                    <Icon size={15} className={on ? 'text-accent' : 'text-text-3'} />
                    <Label
                      htmlFor={`storage-group-${g.key}`}
                      className="flex-1 cursor-pointer text-sm font-normal text-text"
                    >
                      {g.defaultName}
                    </Label>
                    <Switch
                      id={`storage-group-${g.key}`}
                      checked={on}
                      onCheckedChange={(next) =>
                        setEnabled((prev) => ({ ...prev, [g.key]: next }))
                      }
                    />
                  </li>
                );
              })}
            </ul>
            {/* Say what the switches will actually produce. The tabs are the
                thing the client sees next, so naming them here makes the
                switches concrete rather than abstract. */}
            <p className="text-xs text-text-3">
              {chosen.length === 0
                ? isScrap
                  ? 'None — material is issued to the location itself, so it needs nowhere to put things.'
                  : 'Choose at least one — a location needs somewhere to put things.'
                : `Creates ${chosen.length} ${chosen.length === 1 ? 'tab' : 'tabs'}: ${chosen
                    .map((g) => g.defaultName)
                    .join(', ')}. Each starts empty and can be renamed.${
                    isScrap ? ' Stock can still be transferred into these.' : ''
                  }`}
            </p>
          </div>
            </>
          ) : (
            <div className="rounded-lg border border-border bg-surface/50 px-3 py-2.5">
              <p className="text-xs font-medium text-text-2">No shelves, fridges or freezers</p>
              <p className="mt-0.5 text-xs text-text-3">
                Nothing is stored at a debit-and-gone location, so it has nowhere to put stock.
                Its page shows what has been issued here instead.
              </p>
            </div>
          )}

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
          <Button
            type="button"
            variant="primary"
            onClick={submit}
            disabled={busy || (chosen.length === 0 && !isScrap)}
          >
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
