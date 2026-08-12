'use client';

/**
 * Create one location from the standard template (REQ-2026-08-04-LOC-001).
 *
 * Name it, then switch on the sub-types it uses. All three start ON: the
 * requirement provisions a location with all three, and leaving one out is the
 * exception rather than the rule. A switched-off sub-type is simply not created
 * — "a location without a given sub-type simply does not use it".
 *
 * The switches are not a setting stored against the location; each one that is
 * on becomes a real group node the client may rename afterwards. That is why
 * they can be changed later (the ⋯ menu on the location) rather than being
 * frozen at creation.
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
import { locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';

import { STORAGE_GROUPS } from './storage-groups';

export function CreateStorageLocationDialog({
  room,
  existingNames,
  onClose,
  onDone,
}: {
  room: NodeTree;
  /** Names already used in this room — checked client-side so the obvious
   *  mistake is caught before a round trip. The server checks too. */
  existingNames: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = React.useState('');
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
      setError(`“${v}” already exists in ${room.name}.`);
      return;
    }
    if (chosen.length === 0) {
      setError('Choose at least one sub-type — a location needs somewhere to put things.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.createStorageCategory(room.id, {
        name: v,
        ...Object.fromEntries(STORAGE_GROUPS.map((g) => [g.key, Boolean(enabled[g.key])])),
      });
      // Receipt Admin and kitting cache the destination tree for the session, so
      // a new location is invisible to those pickers until the cache is dropped.
      // Every mutation of the location structure has to do this.
      invalidateLocationForest();
      toast.success('Location created', {
        description: `${v} — ${chosen.map((g) => g.defaultName).join(', ')}`,
      });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'node_name_conflict') {
        setError(`“${v}” already exists in ${room.name}.`);
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

          <div className="space-y-2">
            <p className="text-xs font-medium text-text-2">Sub-types this location uses</p>
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
                ? 'Choose at least one — a location needs somewhere to put things.'
                : `Creates ${chosen.length} ${chosen.length === 1 ? 'tab' : 'tabs'}: ${chosen
                    .map((g) => g.defaultName)
                    .join(', ')}. Each starts empty and can be renamed.`}
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
          <Button
            type="button"
            variant="primary"
            onClick={submit}
            disabled={busy || chosen.length === 0}
          >
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
