'use client';

import * as React from 'react';
import Link from 'next/link';
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '@/components/ui/searchable-select';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { isBuiltTier, type TierType } from '@/lib/api/tiers';
import type { ReauthResponse } from '@/lib/api/auth';
import { bomApi, type ApiBomLine, type ApiWhereUsed } from '@/lib/api/bom';
import { itemsApi, type ApiItem } from '@/lib/api/items';
import type { BadgeTone } from '@/types/ui';
import type { InventoryStatus } from '@/types/inventory';
import { formatNumber } from '@/lib/utils';

/** Map a v_item_stock status_code to the inventory status label (for the badge). */
function statusLabel(code: 'available' | 'low_stock' | 'out_of_stock'): InventoryStatus {
  return code === 'available'
    ? 'Available'
    : code === 'low_stock'
      ? 'Low stock'
      : 'Out of stock';
}

interface Props {
  itemId: string;
  itemNumber: string;
  /** Built tiers (AY/FG) can have a BOM; raw materials show where-used only. */
  itemTierType: TierType;
}

// A pending e-signed BOM action, captured before the reauth prompt.
type Pending =
  | { kind: 'add'; childId: string; qty: number }
  | { kind: 'update'; line: ApiBomLine; qty: number }
  | { kind: 'delete'; line: ApiBomLine };

const REAUTH_ACTION: Record<Pending['kind'], string> = {
  add: 'bom.create',
  update: 'bom.update',
  delete: 'bom.delete',
};

/**
 * BOM & usage tab for an inventory item.
 *
 * For a Product (built) item it manages the direct bill of materials —
 * adding, re-quantifying and removing lines, each electronically signed. For
 * every item it lists where it's used (the Products that consume it).
 */
export function ItemBomTab({ itemId, itemNumber, itemTierType }: Props) {
  const isBuilt = isBuiltTier(itemTierType);

  const [lines, setLines] = React.useState<ApiBomLine[]>([]);
  const [whereUsed, setWhereUsed] = React.useState<ApiWhereUsed[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Add-line form state.
  const [items, setItems] = React.useState<ApiItem[]>([]);
  const [addChild, setAddChild] = React.useState('');
  const [addQty, setAddQty] = React.useState('1');

  // Edit-qty state (the line being re-quantified inline).
  const [editing, setEditing] = React.useState<{ id: string; qty: string } | null>(null);

  // e-sign.
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [showReauth, setShowReauth] = React.useState(false);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [bom, used] = await Promise.all([
          isBuilt
            ? bomApi.forItem(itemId, { signal })
            : Promise.resolve({ item_id: itemId, lines: [] }),
          bomApi.whereUsed(itemId, { signal }),
        ]);
        setLines(bom.lines);
        setWhereUsed(used);
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

  const inBom = React.useMemo(
    () => new Set(lines.map((l) => l.child_item_id)),
    [lines],
  );

  // Only raw materials and sub-assemblies may be components, and never a
  // consumable — see the guards in ``add_bom_line``, which are the real
  // enforcement. This filter keeps ineligible items out of the picker so the
  // operator isn't offered a choice the API will reject.
  const addOptions: SearchableSelectOption[] = items
    .filter(
      (c) =>
        c.id !== itemId &&
        !inBom.has(c.id) &&
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

  // ── e-sign plumbing ────────────────────────────────────────────────────

  const requestSign = (p: Pending) => {
    setPending(p);
    setShowReauth(true);
  };

  const onConfirmed = async (evidence: ReauthResponse) => {
    if (!pending) return;
    const reason = evidence.comment ?? '';
    try {
      if (pending.kind === 'add') {
        await bomApi.addLine(itemId, {
          child_item_id: pending.childId,
          qty_per_unit: pending.qty,
          evidence_id: evidence.evidence_id,
          reason,
        });
        toast.success('BOM line added');
        setAddChild('');
        setAddQty('1');
      } else if (pending.kind === 'update') {
        await bomApi.updateLine(pending.line.id, {
          qty_per_unit: pending.qty,
          evidence_id: evidence.evidence_id,
          reason,
        });
        toast.success('BOM line updated');
        setEditing(null);
      } else {
        await bomApi.removeLine(pending.line.id, {
          evidence_id: evidence.evidence_id,
          reason,
        });
        toast.success('BOM line removed');
      }
      setPending(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'bom_cycle') {
          toast.error('Would create a circular reference', { description: err.message });
        } else if (err.code === 'bom_line_conflict') {
          toast.error('Already a BOM line');
        } else if (err.code === 'child_finished_good') {
          toast.error('Finished goods can’t be components', {
            description: err.message,
          });
        } else if (err.code === 'child_consumable') {
          toast.error('Consumables can’t be in a BOM', {
            description: err.message,
          });
        } else if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          toast.error('Your signature expired or was already used. Sign again.');
        } else {
          toast.error('BOM update failed', { description: err.message });
        }
      } else {
        toast.error('BOM update failed');
      }
    }
  };

  const meaning = React.useMemo(() => {
    if (!pending) return '';
    if (pending.kind === 'add')
      return `I am adding a bill-of-materials line to ${itemNumber}.`;
    if (pending.kind === 'update')
      return `I am changing a bill-of-materials quantity on ${itemNumber}.`;
    return `I am removing a bill-of-materials line from ${itemNumber}.`;
  }, [pending, itemNumber]);

  // ── Render ─────────────────────────────────────────────────────────────

  if (error) return <EmptyState title="Couldn't load BOM" hint={error} />;
  if (loading && lines.length === 0 && whereUsed.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-text-3" role="status">
        Loading BOM…
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      {/* ── Bill of materials (built items only) ── */}
      {isBuilt && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Bill of materials</h3>
          </div>

          {lines.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-text-3">
              No BOM lines yet. Add the first component or sub-assembly below.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface text-left text-[11px] uppercase tracking-wider text-text-3">
                    <th className="px-4 py-2.5 font-medium">Child item</th>
                    <th className="px-4 py-2.5 text-right font-medium">Qty / run</th>
                    <th className="px-4 py-2.5 text-right font-medium">Available</th>
                    <th className="px-4 py-2.5 font-medium">Stock status</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className="border-b border-border/60">
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/inventory/${l.child_item_number}/ledger`}
                          className="font-mono text-xs text-accent hover:underline"
                        >
                          {l.child_item_number}
                        </Link>
                        <span className="ml-2 text-text-2">{l.child_description}</span>
                        <Badge
                          tone={(l.child_tier_tone as BadgeTone) ?? 'neutral'}
                          dot
                          className="ml-2"
                        >
                          {l.child_tier_name}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {editing?.id === l.id ? (
                          <Input
                            type="number"
                            min={1}
                            value={editing.qty}
                            onChange={(e) =>
                              setEditing({ id: l.id, qty: e.target.value })
                            }
                            className="ml-auto w-20 text-right"
                          />
                        ) : (
                          `×${formatNumber(Number(l.qty_per_unit))}`
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-text-2">
                        {isBuiltTier(l.child_tier_type) ? (
                          <span className="text-text-3">—</span>
                        ) : (
                          formatNumber(Number(l.child_qty_available))
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {isBuiltTier(l.child_tier_type) ? (
                          <span className="text-text-3">—</span>
                        ) : (
                          <StatusBadge status={statusLabel(l.child_status_code)} />
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {editing?.id === l.id ? (
                            <>
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => {
                                  const qty = Number(editing.qty);
                                  if (qty > 0) requestSign({ kind: 'update', line: l, qty });
                                }}
                              >
                                <ShieldCheck size={13} /> Sign
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditing(null)}
                              >
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Edit quantity"
                                onClick={() =>
                                  setEditing({ id: l.id, qty: String(Number(l.qty_per_unit)) })
                                }
                              >
                                <Pencil size={14} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-danger"
                                aria-label="Remove line"
                                onClick={() => requestSign({ kind: 'delete', line: l })}
                              >
                                <Trash2 size={14} />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Add line */}
          <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3">
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
              <label className="mb-1 block text-xs font-medium text-text-2">
                Qty / run
              </label>
              <Input
                type="number"
                min={1}
                value={addQty}
                onChange={(e) => setAddQty(e.target.value)}
                aria-label="Quantity per unit"
              />
            </div>
            <Button
              variant="primary"
              disabled={!addChild || Number(addQty) <= 0}
              onClick={() =>
                requestSign({ kind: 'add', childId: addChild, qty: Number(addQty) })
              }
            >
              <Plus size={14} /> Add line (sign)
            </Button>
          </div>
        </section>
      )}

      {/* ── Where used ── (shown for all items: a component's consumers, or a
          sub-assembly's parent products). */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Used in</h3>
        {whereUsed.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-text-3">
            Not consumed by any Product&apos;s bill of materials.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {whereUsed.map((p) => (
              <Link
                key={p.parent_item_id}
                href={`/inventory/${encodeURIComponent(p.parent_item_number)}/ledger`}
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface"
              >
                <span className="font-mono text-text-2">{p.parent_item_number}</span>{' '}
                <span className="text-text">{p.parent_description}</span>{' '}
                <span className="text-text-3">×{formatNumber(Number(p.qty_per_unit))}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action={pending ? REAUTH_ACTION[pending.kind] : 'bom.update'}
        meaning={meaning}
        commentPlaceholder="e.g. Added per updated build sheet"
        onConfirmed={onConfirmed}
        title="Sign this BOM change"
        submitLabel="Sign"
      />
    </div>
  );
}
