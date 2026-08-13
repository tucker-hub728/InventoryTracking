'use client';

/**
 * Change which sub-types a location uses, after it was created (LOC-004).
 *
 * The same three switches as the create dialog, with one rule added: a sub-type
 * that still holds units cannot be switched off. Switching it off would hide
 * that stock rather than move it — the ledger would go on counting it while no
 * screen showed where it was. The switch renders disabled with the reason, and
 * the server refuses it independently (``storage_group_in_use``); the disabled
 * control is a courtesy, not the enforcement.
 *
 * Switching one back ON revives the group node it had, so units that were there
 * before a sub-type was switched off come back with it.
 *
 * Super-Admin-only (LOC-004).
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
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { invalidateLocationForest } from '@/components/reconciliation/location-tree-picker';
import { ApiError } from '@/lib/api/client';
import { locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';

import { STORAGE_GROUPS } from './storage-groups';

export function ConfigureGroupsDialog({
  category,
  onClose,
  onDone,
}: {
  category: NodeTree;
  onClose: () => void;
  onDone: () => void;
}) {
  const groups = React.useMemo(() => category.children ?? [], [category]);

  /** ``code → units it holds`` for the groups that currently exist. */
  const state = React.useMemo(() => {
    const map = new Map<string, { name: string; units: number }>();
    for (const g of groups) {
      map.set(g.code.toUpperCase(), {
        name: g.name,
        units: (g.children ?? []).length,
      });
    }
    return map;
  }, [groups]);

  const [enabled, setEnabled] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(STORAGE_GROUPS.map((g) => [g.key, state.has(g.code)])),
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const chosen = STORAGE_GROUPS.filter((g) => enabled[g.key]);
  const dirty = STORAGE_GROUPS.some((g) => Boolean(enabled[g.key]) !== state.has(g.code));

  // A scrap location may keep NONE — the location itself is the destination, so
  // it needs nowhere to put things. The create dialog already allows that, and
  // the server relaxes its own at-least-one rule for a scrap category; without
  // the same relaxation here a location could be CREATED with zero sub-types and
  // then never returned to zero, which is a state the UI can reach but not undo.
  const mayBeEmpty = Boolean(category.is_scrap);

  const submit = async () => {
    if (chosen.length === 0 && !mayBeEmpty) {
      setError('A location must keep at least one sub-type.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.updateStorageGroups(category.id, {
        shelf: Boolean(enabled.shelf),
        refrigerator: Boolean(enabled.refrigerator),
        freezer: Boolean(enabled.freezer),
      });
      invalidateLocationForest();
      toast.success('Sub-types updated', {
        description:
          chosen.length === 0
            ? `${category.name} — no sub-types; material is issued to the location itself`
            : `${category.name} — ${chosen.map((g) => g.defaultName).join(', ')}`,
      });
      onDone();
    } catch (err) {
      // The server is the authority on "still holds units": the tree this
      // dialog was opened with may be a few seconds stale.
      setError(err instanceof ApiError ? err.message : 'Failed to update the sub-types.');
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Configure sub-types</DialogTitle>
          <DialogDescription>
            Which of the template’s sub-types {category.name} uses. Switching one off removes
            its tab; it can be switched back on later.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <ul className="divide-y divide-border rounded-lg border border-border">
            {STORAGE_GROUPS.map((g) => {
              const Icon = g.icon;
              const existing = state.get(g.code);
              const on = Boolean(enabled[g.key]);
              // Only a group that EXISTS and holds units is locked. One that is
              // already off holds nothing by definition.
              const locked = Boolean(existing && existing.units > 0 && on);
              return (
                <li key={g.key} className="flex items-center gap-3 px-3 py-2.5">
                  <Icon size={15} className={on ? 'text-accent' : 'text-text-3'} />
                  <div className="min-w-0 flex-1">
                    <Label
                      htmlFor={`configure-group-${g.key}`}
                      className={
                        locked
                          ? 'text-sm font-normal text-text'
                          : 'cursor-pointer text-sm font-normal text-text'
                      }
                    >
                      {/* The group's own name if it exists — it may have been
                          renamed away from the template's default. */}
                      {existing?.name ?? g.defaultName}
                    </Label>
                    <p className="mt-0.5 text-[11px] text-text-3">
                      {locked
                        ? `Holds ${existing!.units} ${existing!.units === 1 ? 'unit' : 'units'} — move or remove them to switch this off`
                        : existing
                          ? 'Empty'
                          : 'Not used'}
                    </p>
                  </div>
                  <Switch
                    id={`configure-group-${g.key}`}
                    checked={on}
                    disabled={locked}
                    onCheckedChange={(next) =>
                      setEnabled((prev) => ({ ...prev, [g.key]: next }))
                    }
                  />
                </li>
              );
            })}
          </ul>

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
            disabled={busy || !dirty || (chosen.length === 0 && !mayBeEmpty)}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
