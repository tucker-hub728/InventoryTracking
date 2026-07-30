'use client';

/**
 * Add / rename dialogs for a room's locations and sub-locations.
 *
 * Lifted out of ``materials-management-client.tsx`` when Cold Storage and the
 * Analytical Lab got screens of their own — all three rooms create and rename
 * the same two node types, so the dialogs belong to no one room.
 *
 * Both are Super-Admin-only actions (LOC-003 / LOC-006); the API enforces that
 * and the caller decides whether to render the control at all.
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
import { ApiError } from '@/lib/api/client';
import { invalidateLocationForest } from '@/components/reconciliation/location-tree-picker';
import { locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';

/** Create a location or one of its sub-locations. The name IS the code —
 *  LOC-006 keeps a unit's identifier a single free-text field that the system
 *  never parses, validates or decomposes. */
export function AddNodeDialog({
  title,
  description,
  fieldLabel,
  placeholder,
  nodeType,
  parent,
  onClose,
  onDone,
}: {
  title: string;
  description: string;
  fieldLabel: string;
  placeholder: string;
  /** A Cold Storage group (``room_location``) or one of its equipment units
   *  (``sub_location``). Both are Super-Admin-only to create
   *  (``SUPER_ADMIN_NODE_TYPES`` on the API).
   *
   *  ``shelf`` is absent on purpose — LOC-005 fixes Warehouse One at Shelf A
   *  through Shelf Z, so there is no shelf to add. */
  nodeType: 'room_location' | 'sub_location';
  parent: NodeTree;
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const v = value.trim();
    if (!v) {
      setError(`${fieldLabel} is required.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.create({
        node_type: nodeType,
        code: v,
        name: v,
        parent_id: parent.id,
      });
      // The destination tree used by Receipt Admin and kitting is cached for the
      // session, so a new unit is invisible to those pickers until the cache is
      // dropped. Every mutation of the location structure has to do this.
      invalidateLocationForest();
      toast.success(`${title.replace('Add ', 'Added ')}`, { description: v });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'node_code_conflict') {
        setError(`“${v}” already exists in ${parent.name}.`);
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to add.');
      }
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="add-node-value">{fieldLabel}</Label>
            <Input
              id="add-node-value"
              autoFocus
              className="font-mono"
              placeholder={placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
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
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RenameNodeDialog({
  node,
  onClose,
  onDone,
}: {
  node: NodeTree;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = React.useState(node.name);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const n = name.trim();
    if (!n) {
      setError('A name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.rename(node.id, n);
      // The cached tree carries names, so the pickers would keep showing the old
      // one for the rest of the session.
      invalidateLocationForest();
      toast.success('Renamed', { description: n });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rename.');
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rename-name">Name</Label>
            <Input
              id="rename-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
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
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
