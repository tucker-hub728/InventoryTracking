'use client';

import * as React from 'react';
import Link from 'next/link';
import { Plus, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchableSelect, type SearchableSelectOption } from '@/components/ui/searchable-select';
import { useMinDuration } from '@/hooks/use-min-duration';
import { EmptyState } from '@/components/shared/empty-state';
import { TableSkeleton } from '@/components/shared/table-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { StockStatusBadge } from '@/components/shared/stock-status-badge';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { isBuiltTier, type TierType } from '@/lib/api/tiers';
import type { ReauthResponse } from '@/lib/api/auth';
import { bomApi, type ApiBomLine } from '@/lib/api/bom';
import { itemsApi, type ApiItem } from '@/lib/api/items';
import type { BadgeTone } from '@/types/ui';
import type { InventoryStatus } from '@/types/inventory';
import { cn, formatNumber } from '@/lib/utils';

/** Map a v_item_stock status_code to the inventory status label (for the badge). */
function statusLabel(code: 'available' | 'low_stock' | 'out_of_stock'): InventoryStatus {
  return code === 'available' ? 'Available' : code === 'low_stock' ? 'Low stock' : 'Out of stock';
}

/** A bill is either undefined (empty) or a real combination — never a single
 *  line. Transaction Spec §1.1 states every legal build as a pair of components
 *  (CR+CR→AY, AY+AY→AY, CR+CR→FG, CR+AY→FG). Mirrors ``BOM_MIN_LINES``
 *  server-side, which is the real enforcement. */
const MIN_LINES = 2;

interface Props {
  itemId: string;
  itemNumber: string;
  /** Built tiers (AY/FG) can have a BOM; raw materials show where-used only. */
  itemTierType: TierType;
}

/** A component staged for adding but not yet saved. */
interface StagedLine {
  key: string;
  childId: string;
  qty: string;
}

/**
 * BOM tab for a built item — the direct bill of materials.
 *
 * Changes are **staged, then signed once**: components are added to the list,
 * quantities re-typed and lines marked for removal without a password prompt,
 * and a single e-signature commits the whole batch atomically (one call to
 * ``POST /items/{id}/bom/batch``). Nothing reaches the server until that save,
 * so an abandoned edit leaves the stored bill untouched.
 *
 * Where-used ("Used in") lives in its own tab (ItemWhereUsedTab).
 */
export function ItemBomTab({ itemId, itemNumber, itemTierType }: Props) {
  const isBuilt = isBuiltTier(itemTierType);

  const [lines, setLines] = React.useState<ApiBomLine[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Held briefly — the fetch returns in ~20ms, too fast to see otherwise.
  const showSkeleton = useMinDuration(loading && lines.length === 0);

  // Add-line form state (staging only — no write).
  const [items, setItems] = React.useState<ApiItem[]>([]);
  const [addChild, setAddChild] = React.useState('');
  const [addQty, setAddQty] = React.useState('1');

  // ── The unsaved draft ──────────────────────────────────────────────────
  const [staged, setStaged] = React.useState<StagedLine[]>([]);
  // lineId → re-typed qty (kept as a string so the field can be cleared).
  const [qtyEdits, setQtyEdits] = React.useState<Record<string, string>>({});
  // lineIds marked for removal.
  const [removed, setRemoved] = React.useState<string[]>([]);

  const [showReauth, setShowReauth] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const nextKey = React.useRef(0);

  const resetDraft = React.useCallback(() => {
    setStaged([]);
    setQtyEdits({});
    setRemoved([]);
    setAddChild('');
    setAddQty('1');
  }, []);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const bom = isBuilt
          ? await bomApi.forItem(itemId, { signal })
          : { item_id: itemId, lines: [] };
        setLines(bom.lines);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load BOM.');
      } finally {
        setLoading(false);
      }
    },
    [itemId, isBuilt],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Load the item pool for the add-line picker (built items only).
  React.useEffect(() => {
    if (!isBuilt) return;
    const ctrl = new AbortController();
    itemsApi
      .list({ limit: 200 }, { signal: ctrl.signal })
      .then((resp) => setItems(resp.items))
      .catch(() => {});
    return () => ctrl.abort();
  }, [isBuilt]);

  const itemById = React.useMemo(
    () => new Map(items.map((i) => [i.id, i])),
    [items],
  );

  // Components that will be on the bill once the draft lands — a child freed by
  // a staged removal becomes selectable again.
  const takenChildren = React.useMemo(() => {
    const taken = new Set(
      lines.filter((l) => !removed.includes(l.id)).map((l) => l.child_item_id),
    );
    staged.forEach((s) => taken.add(s.childId));
    return taken;
  }, [lines, removed, staged]);

  // Only raw materials and sub-assemblies may be components, and never a
  // consumable — see the guards in ``_require_eligible_child``, which are the
  // real enforcement. This filter keeps ineligible items out of the picker so
  // the operator isn't offered a choice the API will reject.
  const addOptions: SearchableSelectOption[] = items
    .filter(
      (c) =>
        c.id !== itemId &&
        !takenChildren.has(c.id) &&
        c.tier_type !== 'finished_good' &&
        !c.is_consumable,
    )
    .map((c) => ({
      value: c.id,
      searchText: `${c.item_number} ${c.description} ${c.tier_name}`,
      label: (
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-text-2">{c.item_number}</span>
          <span className="truncate">{c.description}</span>
          <Badge tone={(c.tier_tone as BadgeTone) ?? 'neutral'} dot className="ml-auto">
            {c.tier_name}
          </Badge>
        </span>
      ),
    }));

  // ── Draft maths ────────────────────────────────────────────────────────

  /** Saved lines whose quantity was re-typed to a genuinely different value. */
  const editedIds = React.useMemo(
    () =>
      lines
        .filter((l) => {
          if (removed.includes(l.id)) return false;
          const typed = qtyEdits[l.id];
          if (typed === undefined) return false;
          const qty = Number(typed);
          return qty > 0 && qty !== Number(l.qty_per_unit);
        })
        .map((l) => l.id),
    [lines, qtyEdits, removed],
  );

  const changeCount = staged.length + editedIds.length + removed.length;
  const dirty = changeCount > 0;
  const finalCount = lines.length - removed.length + staged.length;
  /** A save that would leave exactly one component is refused (see MIN_LINES). */
  const belowMin = finalCount > 0 && finalCount < MIN_LINES;
  const badQty =
    staged.some((s) => !(Number(s.qty) > 0)) ||
    lines.some((l) => !removed.includes(l.id) && qtyEdits[l.id] !== undefined && !(Number(qtyEdits[l.id]) > 0));
  const canSave = dirty && !belowMin && !badQty && !saving;

  const addStaged = () => {
    if (!addChild || !(Number(addQty) > 0)) return;
    setStaged((prev) => [
      ...prev,
      { key: `staged-${nextKey.current++}`, childId: addChild, qty: addQty },
    ]);
    setAddChild('');
    setAddQty('1');
  };

  const qtyFor = (l: ApiBomLine) => qtyEdits[l.id] ?? String(Number(l.qty_per_unit));

  // ── Save (one signature for the whole batch) ───────────────────────────

  const onConfirmed = async (evidence: ReauthResponse) => {
    setSaving(true);
    try {
      const result = await bomApi.saveBatch(itemId, {
        adds: staged.map((s) => ({ child_item_id: s.childId, qty_per_unit: Number(s.qty) })),
        updates: editedIds.map((id) => ({ line_id: id, qty_per_unit: Number(qtyEdits[id]) })),
        deletes: removed,
        evidence_id: evidence.evidence_id,
        reason: evidence.comment ?? '',
      });
      const parts = [
        result.added ? `${result.added} added` : null,
        result.updated ? `${result.updated} updated` : null,
        result.deleted ? `${result.deleted} removed` : null,
      ].filter(Boolean);
      toast.success('Bill of materials saved', { description: parts.join(', ') });
      setLines(result.lines);
      resetDraft();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'bom_cycle') {
          toast.error('Would create a circular reference', { description: err.message });
        } else if (err.code === 'bom_line_conflict') {
          toast.error('That component is already on the bill');
        } else if (err.code === 'bom_min_lines') {
          toast.error('A bill of materials needs at least two components', {
            description: err.message,
          });
        } else if (err.code === 'child_finished_good') {
          toast.error('Finished goods can’t be components', { description: err.message });
        } else if (err.code === 'child_consumable') {
          toast.error('Consumables can’t be in a BOM', { description: err.message });
        } else if (err.code === 'bom_line_not_found') {
          toast.error('A line you changed no longer exists', {
            description: 'Someone else edited this BOM. Reloading.',
          });
          resetDraft();
          void load();
        } else if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          toast.error('Your signature expired or was already used. Sign again.');
        } else {
          toast.error('BOM save failed', { description: err.message });
        }
      } else {
        toast.error('BOM save failed');
      }
    } finally {
      setSaving(false);
    }
  };

  const meaning = `I am saving the bill of materials for ${itemNumber} — ${changeCount} change${
    changeCount === 1 ? '' : 's'
  }.`;

  // ── Render ─────────────────────────────────────────────────────────────

  if (error) return <EmptyState title="Couldn't load BOM" hint={error} />;
  if (showSkeleton) {
    return (
      <div className="space-y-6 p-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <TableSkeleton
            rows={3}
            columns={5}
            className="rounded-md border border-border"
            label="Loading BOM…"
          />
        </div>
      </div>
    );
  }

  const cellBase = 'px-4 py-2.5';

  return (
    <div className="space-y-5 p-4">
      {isBuilt && (
        <section className="space-y-5">
          {/* ── Add a component (stages only — nothing is written yet) ── */}
          <div className="rounded-lg border border-border bg-surface p-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[260px] flex-1">
                <label className="mb-1 block text-xs font-medium text-text-2">
                  Add a component or sub-assembly
                </label>
                <SearchableSelect
                  options={addOptions}
                  value={addChild}
                  onChange={setAddChild}
                  placeholder="Search any item…"
                  searchPlaceholder="Search item # or description…"
                  emptyText="No eligible items."
                  aria-label="Add BOM child"
                />
              </div>
              <div className="w-24">
                <label className="mb-1 block text-xs font-medium text-text-2">Qty / run</label>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={addQty}
                  onChange={(e) => setAddQty(e.target.value.replace(/[^0-9]/g, ''))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addStaged();
                  }}
                  aria-label="Quantity per unit"
                />
              </div>
              <Button
                variant="secondary"
                disabled={!addChild || !(Number(addQty) > 0)}
                onClick={addStaged}
              >
                <Plus size={14} /> Add to list
              </Button>
            </div>
            <p className="mt-2 text-xs text-text-3">
              Build the whole bill, then sign once to save it. Nothing is written until you save.
            </p>
          </div>

          {/* ── The bill (saved lines + everything staged) ── */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Bill of materials</h3>
              {dirty && (
                <span className="text-xs font-medium text-warning">
                  {changeCount} unsaved change{changeCount === 1 ? '' : 's'}
                </span>
              )}
            </div>

            {lines.length === 0 && staged.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-text-3">
                No BOM lines yet. Add components above — a bill needs at least{' '}
                {MIN_LINES} — then sign once to save.
              </p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface text-left text-[11px] uppercase tracking-wider text-text-3">
                      <th className={cn(cellBase, 'py-2.5 font-medium')}>Child item</th>
                      <th className={cn(cellBase, 'text-right font-medium')}>Qty / run</th>
                      <th className={cn(cellBase, 'text-right font-medium')}>Available</th>
                      <th className={cn(cellBase, 'font-medium')}>Stock status</th>
                      <th className={cellBase} />
                    </tr>
                  </thead>
                  <tbody>
                    {/* Saved lines — editable in place, removable, undoable. */}
                    {lines.map((l) => {
                      const isRemoved = removed.includes(l.id);
                      const isEdited = editedIds.includes(l.id);
                      return (
                        <tr
                          key={l.id}
                          className={cn(
                            'border-border/60 border-b',
                            isRemoved && 'bg-danger-soft/30 text-text-3',
                            isEdited && 'bg-warning-soft/30',
                          )}
                        >
                          <td className={cellBase}>
                            <Link
                              href={`/inventory/${l.child_item_id}/ledger`}
                              className={cn(
                                'font-mono text-xs text-accent hover:underline',
                                isRemoved && 'line-through',
                              )}
                            >
                              {l.child_item_number}
                            </Link>
                            <span className={cn('ml-2 text-text-2', isRemoved && 'line-through')}>
                              {l.child_description}
                            </span>
                            <Badge
                              tone={(l.child_tier_tone as BadgeTone) ?? 'neutral'}
                              dot
                              className="ml-2"
                            >
                              {l.child_tier_name}
                            </Badge>
                            {isRemoved && (
                              <Badge tone="danger" className="ml-2">
                                Removing
                              </Badge>
                            )}
                            {isEdited && (
                              <Badge tone="warning" className="ml-2">
                                Edited
                              </Badge>
                            )}
                          </td>
                          <td className={cn(cellBase, 'text-right font-mono')}>
                            {isRemoved ? (
                              <span className="line-through">
                                ×{formatNumber(Number(l.qty_per_unit))}
                              </span>
                            ) : (
                              <Input
                                type="number"
                                min={1}
                                step={1}
                                value={qtyFor(l)}
                                onChange={(e) =>
                                  setQtyEdits((prev) => ({
                                    ...prev,
                                    [l.id]: e.target.value.replace(/[^0-9]/g, ''),
                                  }))
                                }
                                className={cn(
                                  'ml-auto w-20 text-right',
                                  !(Number(qtyFor(l)) > 0) && 'border-danger',
                                )}
                                aria-label={`Quantity per unit for ${l.child_item_number}`}
                              />
                            )}
                          </td>
                          {/* Shown for every component, sub-assemblies included: a
                              sub-assembly "shall itself be stockable as inventory"
                              (REQ-2026-07-01-INV-003), so it has a real on-hand
                              balance — kitting reads it to decide what can be
                              pulled. A finished good can't be a component at all
                              (Transaction Spec §1.1), so nothing here is unstocked. */}
                          <td className={cn(cellBase, 'text-right font-mono text-text-2')}>
                            {formatNumber(Number(l.child_qty_available))}
                          </td>
                          <td className={cellBase}>
                            <StockStatusBadge
                              status={statusLabel(l.child_status_code)}
                              qtyAvailable={Number(l.child_qty_available)}
                              reorderThreshold={Number(l.child_reorder_threshold)}
                              qtyAwaitingRelease={Number(l.child_qty_awaiting_release)}
                            />
                          </td>
                          <td className={cn(cellBase, 'text-right')}>
                            {isRemoved ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setRemoved((prev) => prev.filter((id) => id !== l.id))}
                              >
                                <RotateCcw size={13} /> Undo
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-danger"
                                aria-label={`Remove ${l.child_item_number}`}
                                onClick={() => setRemoved((prev) => [...prev, l.id])}
                              >
                                <Trash2 size={14} />
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}

                    {/* Staged additions — not yet on the server. */}
                    {staged.map((s) => {
                      const child = itemById.get(s.childId);
                      return (
                        <tr key={s.key} className="border-border/60 border-b bg-accent-soft/25">
                          <td className={cellBase}>
                            <span className="font-mono text-xs text-text-2">
                              {child?.item_number ?? '—'}
                            </span>
                            <span className="ml-2 text-text-2">{child?.description ?? ''}</span>
                            {child && (
                              <Badge
                                tone={(child.tier_tone as BadgeTone) ?? 'neutral'}
                                dot
                                className="ml-2"
                              >
                                {child.tier_name}
                              </Badge>
                            )}
                            <Badge tone="accent" className="ml-2">
                              New
                            </Badge>
                          </td>
                          <td className={cn(cellBase, 'text-right font-mono')}>
                            <Input
                              type="number"
                              min={1}
                              step={1}
                              value={s.qty}
                              onChange={(e) =>
                                setStaged((prev) =>
                                  prev.map((row) =>
                                    row.key === s.key
                                      ? { ...row, qty: e.target.value.replace(/[^0-9]/g, '') }
                                      : row,
                                  ),
                                )
                              }
                              className={cn(
                                'ml-auto w-20 text-right',
                                !(Number(s.qty) > 0) && 'border-danger',
                              )}
                              aria-label={`Quantity per unit for ${child?.item_number ?? 'new line'}`}
                            />
                          </td>
                          <td className={cn(cellBase, 'text-right font-mono text-text-2')}>
                            {child ? formatNumber(Number(child.qty_available)) : '—'}
                          </td>
                          <td className={cellBase}>
                            {child && (
                              <StockStatusBadge
                                status={statusLabel(child.status_code)}
                                qtyAvailable={Number(child.qty_available)}
                                reorderThreshold={Number(child.reorder_threshold)}
                                qtyAwaitingRelease={Number(child.qty_awaiting_release)}
                              />
                            )}
                          </td>
                          <td className={cn(cellBase, 'text-right')}>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-danger"
                              aria-label="Discard this staged line"
                              onClick={() =>
                                setStaged((prev) => prev.filter((row) => row.key !== s.key))
                              }
                            >
                              <Trash2 size={14} />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {belowMin && (
              <p className="rounded-md border border-warning-soft bg-warning-soft/40 px-3 py-2 text-xs text-text-2">
                A bill of materials needs at least {MIN_LINES} components. Add another line, or
                remove them all to clear the BOM.
              </p>
            )}

            {/* Save bar — appears only once there is something to save. */}
            {dirty && (
              <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent bg-bg-elev px-3 py-2.5 shadow-md">
                <span className="text-xs text-text-2">
                  {staged.length > 0 && `${staged.length} to add`}
                  {staged.length > 0 && (editedIds.length > 0 || removed.length > 0) && ' · '}
                  {editedIds.length > 0 && `${editedIds.length} re-quantified`}
                  {editedIds.length > 0 && removed.length > 0 && ' · '}
                  {removed.length > 0 && `${removed.length} to remove`}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={resetDraft} disabled={saving}>
                    Discard changes
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!canSave}
                    onClick={() => setShowReauth(true)}
                  >
                    <ShieldCheck size={13} />
                    {saving ? 'Saving…' : 'Save changes (sign)'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action="bom.save"
        recordTable="app.items"
        recordId={itemId}
        meaning={meaning}
        commentPlaceholder="e.g. Added per updated build sheet"
        onConfirmed={onConfirmed}
        title="Sign this BOM change"
        submitLabel="Sign & save"
      />
    </div>
  );
}
