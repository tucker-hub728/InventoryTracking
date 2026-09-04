'use client';

/**
 * Change a location's sub-types after it was created (LOC-001).
 *
 * This was three switches — Shelf, Refrigerator, Freezer — until 2026-08-13,
 * when the amended LOC-001 asked for exactly the thing a switch per sub-type
 * cannot express: adding "an additional freezer (e.g. minus-80 alongside
 * minus-20)". A location may now hold as many sub-types as it needs, told apart
 * only by the names the client gives them, so the control is a LIST you add rows
 * to rather than a fixed set you toggle.
 *
 * Two rules survive from the switch version:
 *
 *   * A sub-type that still holds units cannot be removed. Removing it would
 *     hide that stock rather than move it, and the ledger would go on counting
 *     it. The Remove button renders disabled with the reason, and the server
 *     refuses it independently (``storage_group_in_use``) — the disabled control
 *     is a courtesy, not the enforcement.
 *   * Adding a name that a removed sub-type already had REVIVES that node rather
 *     than minting a second one under a new code, which would break every link
 *     already built from the old one. That happens server-side; nothing here has
 *     to know which names are dormant.
 *
 * Nothing is applied until Save: removals are staged and undoable, so the whole
 * reconfiguration is one signed-off change rather than a sequence of them.
 *
 * Super-Admin-only (LOC-004).
 */

import * as React from 'react';
import { Plus, RotateCcw, X } from 'lucide-react';

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
import { locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';
import { cn } from '@/lib/utils';

import { STORAGE_GROUPS, groupByKind, groupFor, type StorageGroupKind } from './storage-groups';

/** Max name length, matching ``StorageGroupRef.name`` on the server. */
const MAX_NAME = 128;

/** One sub-type staged for adding: its kind, and the name it will carry. */
interface PendingGroup {
  kind: StorageGroupKind;
  name: string;
}

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

  /** Ids staged for removal. Staged rather than applied so the whole change is
   *  one Save, and so a mis-click is undoable without reopening the dialog. */
  const [removed, setRemoved] = React.useState<ReadonlySet<string>>(new Set());
  /** Sub-types staged for adding, in the order they were chosen — which is the
   *  order the server numbers their codes in, and therefore the tab order. */
  const [added, setAdded] = React.useState<readonly PendingGroup[]>([]);
  const [draftKind, setDraftKind] = React.useState<StorageGroupKind>('shelf');
  const [draftName, setDraftName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const kept = groups.filter((g) => !removed.has(g.id));
  const total = kept.length + added.length;
  const dirty = removed.size > 0 || added.length > 0;

  /** Every name the location would end up with, lower-cased. Two sub-types with
   *  one name are indistinguishable on a tab strip, and the server's sibling-name
   *  index refuses them anyway — catching it here names the row instead. */
  const finalNames = React.useMemo(
    () =>
      new Set([
        ...kept.map((g) => g.name.toLowerCase()),
        ...added.map((a) => a.name.toLowerCase()),
      ]),
    [kept, added],
  );

  /** What the name box shows when it is left alone: the kind's own name, or
   *  "Freezer 2" when the location already has a Freezer. Prefilled rather than
   *  left blank so adding a first shelf is one click, and so the numbering is
   *  visible BEFORE saving rather than arriving as a surprise. The server
   *  computes the same default if the field is ever sent empty. */
  const suggestedName = React.useMemo(() => {
    const base = groupByKind(draftKind).defaultName;
    if (!finalNames.has(base.toLowerCase())) return base;
    for (let n = 2; n < 100; n += 1) {
      if (!finalNames.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
    }
    return base;
  }, [draftKind, finalNames]);

  const effectiveName = draftName.trim() || suggestedName;
  const duplicate = finalNames.has(effectiveName.toLowerCase());
  const canAdd = effectiveName.length > 0 && effectiveName.length <= MAX_NAME && !duplicate;

  const addDraft = () => {
    if (!canAdd) return;
    setAdded((prev) => [...prev, { kind: draftKind, name: effectiveName }]);
    setDraftName('');
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.updateStorageGroups(category.id, {
        // Declarative: the list the location should end up with. Kept sub-types
        // go by id, new ones by kind + name, and anything absent is removed.
        groups: [
          ...kept.map((g) => ({ id: g.id })),
          ...added.map((a) => ({ kind: a.kind, name: a.name })),
        ],
      });
      invalidateLocationForest();
      toast.success('Sub-types updated', {
        description:
          total === 0
            ? `${category.name} — no sub-types`
            : `${category.name} — ${[...kept.map((g) => g.name), ...added.map((a) => a.name)].join(', ')}`,
      });
      onDone();
    } catch (err) {
      // The server is the authority on "still holds units": the tree this dialog
      // was opened with may be a few seconds stale.
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
            The storage sub-types {category.name} has. There are three kinds — shelf,
            refrigerator and freezer — and a location can have any number of each, named
            however they are labelled in the room.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {total > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {groups.map((group) => {
                const Icon = groupFor(group).icon;
                const units = (group.children ?? []).length;
                const isRemoved = removed.has(group.id);
                // Only a sub-type that HOLDS something is locked. Emptying it
                // first is the operator's own instruction, not a limitation.
                const locked = units > 0;
                return (
                  <li key={group.id} className="flex items-center gap-3 px-3 py-2.5">
                    <Icon
                      size={15}
                      className={isRemoved ? 'text-text-3' : 'text-accent'}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={
                          isRemoved
                            ? 'truncate text-sm text-text-3 line-through'
                            : 'truncate text-sm text-text'
                        }
                      >
                        {group.name}
                      </p>
                      <p className="mt-0.5 text-[11px] text-text-3">
                        {isRemoved
                          ? 'Will be removed when you save'
                          : locked
                            ? `Holds ${units} ${units === 1 ? 'unit' : 'units'} — move or remove them to remove this sub-type`
                            : 'Empty'}
                      </p>
                    </div>
                    {isRemoved ? (
                      <Button
                        type="button"
                        size="icon"
                        aria-label={`Keep ${group.name}`}
                        onClick={() =>
                          setRemoved((prev) => {
                            const next = new Set(prev);
                            next.delete(group.id);
                            return next;
                          })
                        }
                      >
                        <RotateCcw size={14} />
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="icon"
                        aria-label={`Remove ${group.name}`}
                        disabled={locked}
                        onClick={() => setRemoved((prev) => new Set(prev).add(group.id))}
                      >
                        <X size={14} />
                      </Button>
                    )}
                  </li>
                );
              })}
              {added.map((pending, i) => {
                const Icon = groupByKind(pending.kind).icon;
                return (
                  <li key={`new-${i}`} className="flex items-center gap-3 px-3 py-2.5">
                    <Icon size={15} className="text-success" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-text">{pending.name}</p>
                      <p className="mt-0.5 text-[11px] text-text-3">
                        Will be added when you save
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      aria-label={`Don't add ${pending.name}`}
                      onClick={() => setAdded((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X size={14} />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="space-y-2 rounded-lg border border-border bg-surface/50 p-3">
            <p className="text-xs font-medium text-text-2">Add a sub-type</p>

            {/* Kind first, because it is the choice with only three answers and
                it decides what the name box suggests. Segmented buttons rather
                than a dropdown: three options that fit on one row should not
                cost a click to see. */}
            <div className="flex gap-1.5" role="radiogroup" aria-label="Sub-type kind">
              {STORAGE_GROUPS.map((k) => {
                const Icon = k.icon;
                const on = draftKind === k.key;
                return (
                  <button
                    key={k.key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setDraftKind(k.key)}
                    className={cn(
                      'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      on
                        ? 'border-accent bg-accent/10 font-medium text-text'
                        : 'border-border text-text-2 hover:text-text',
                    )}
                  >
                    <Icon size={14} className={on ? 'text-accent' : 'text-text-3'} />
                    {k.defaultName}
                  </button>
                );
              })}
            </div>

            <div className="flex items-start gap-2">
              <div className="flex-1">
                <Label htmlFor="configure-group-new" className="sr-only">
                  Name
                </Label>
                <Input
                  id="configure-group-new"
                  value={draftName}
                  maxLength={MAX_NAME}
                  // The suggestion sits in the PLACEHOLDER, not the value, so it
                  // keeps up with the kind buttons without overwriting anything
                  // typed. Leaving it blank accepts the suggestion.
                  placeholder={suggestedName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter adds the row rather than submitting the dialog —
                    // saving on Enter would drop the name still in the box.
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addDraft();
                    }
                  }}
                  aria-invalid={duplicate || undefined}
                  aria-describedby="configure-group-new-hint"
                />
                <p
                  id="configure-group-new-hint"
                  className={
                    duplicate ? 'mt-1 text-[11px] text-danger' : 'mt-1 text-[11px] text-text-3'
                  }
                >
                  {duplicate
                    ? `${category.name} already has a sub-type called “${effectiveName}”.`
                    : `Adds “${effectiveName}”. Name it the way it is labelled in the room — a second freezer at another temperature is just a second ${groupByKind(
                        draftKind,
                      ).defaultName.toLowerCase()}.`}
                </p>
              </div>
              <Button type="button" onClick={addDraft} disabled={!canAdd}>
                <Plus size={15} />
                <span className="ml-1.5">Add</span>
              </Button>
            </div>
          </div>

          {/* No debit-and-gone branch here: one cannot reach this dialog. Its
              page redirects to /debit-and-gone, and the server refuses to add a
              sub-type to it anyway (storage_groups_scrap). */}
          {total === 0 && (
            <p className="text-xs text-text-2">
              No sub-types yet. Until one is added there is nowhere to put stock at this
              location.
            </p>
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
          <Button type="button" variant="primary" onClick={submit} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
