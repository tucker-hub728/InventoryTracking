'use client';

import * as React from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/empty-state';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { Tabs, TabsContent, TabsList, TabsScroller, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/sonner';
import { selectIsAdminOrAbove, useAuthStore } from '@/stores/auth.store';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import { tiersApi, TIER_TYPE_LABELS, type ApiPrefix, type ApiTier } from '@/lib/api/tiers';
import { cn } from '@/lib/utils';
import type { BadgeTone } from '@/types/ui';

import { TierFormDialog } from './tier-form-dialog';
import { PrefixFormDialog } from './prefix-form-dialog';

const PANEL = 'overflow-hidden rounded-lg border border-border bg-bg-elev';

const TONE_DOT: Record<BadgeTone, string> = {
  neutral: 'bg-text-3',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

// Tabs read in production order (what becomes what), not alphabetically:
// raw material → sub-assembly → finished good.
const TIER_TYPE_ORDER: Record<string, number> = {
  raw_material: 0,
  sub_assembly: 1,
  finished_good: 2,
};

// Tiers are seed-only — the set is fixed at exactly three
// (REQ-2026-07-15-ITM-001), so tier create / edit / delete stay hidden. Prefix
// management is the live admin surface. Flip to restore tier writes.
const TIER_ACTIONS_ENABLED = false;

/** Tier + prefix pair, used to key the prefix edit / delete dialogs. */
interface PrefixRef {
  tier: ApiTier;
  prefix: ApiPrefix;
}

/**
 * Item Tiers admin page. One tab per tier (REQ-2026-07-15-ITM-001 fixes the set
 * at three); each tab lists that tier's admin-managed prefixes in a table
 * (REQ-2026-07-15-ITM-002). Prefix create / edit / delete are electronically
 * signed. Tier writes are gated behind {@link TIER_ACTIONS_ENABLED}.
 */
export function TiersPageClient() {
  // Everyone with inventory:view reaches this page and sees the taxonomy;
  // Read-Only included (REQ-2026-07-09-ROL-001 — "all edit actions hidden",
  // view access kept).
  //
  // Writing it is admin-or-above. The tiers and their prefixes define how the
  // whole catalogue behaves — REQ-2026-07-15-ITM-001 calls them "admin-added"
  // and fixes the category set at three — so operators read but don't edit.
  // A permission check can't express that: operator also holds inventory:sign.
  const isAdmin = useAuthStore(selectIsAdminOrAbove);
  const canWriteTiers = isAdmin && TIER_ACTIONS_ENABLED;
  const canManagePrefixes = isAdmin;

  const [tiers, setTiers] = React.useState<ApiTier[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [activeTierId, setActiveTierId] = React.useState<string>('');

  const [creatingTier, setCreatingTier] = React.useState(false);
  const [editingTier, setEditingTier] = React.useState<ApiTier | null>(null);
  const [deletingTier, setDeletingTier] = React.useState<ApiTier | null>(null);

  // Prefix dialogs. ``addingTo`` holds the tier a new prefix belongs to.
  const [addingTo, setAddingTo] = React.useState<ApiTier | null>(null);
  const [editingPrefix, setEditingPrefix] = React.useState<PrefixRef | null>(null);
  const [deletingPrefix, setDeletingPrefix] = React.useState<PrefixRef | null>(null);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await tiersApi.list({ signal });
      const ordered = [...rows].sort(
        (a, b) => (TIER_TYPE_ORDER[a.type] ?? 99) - (TIER_TYPE_ORDER[b.type] ?? 99),
      );
      setTiers(ordered);
      // Keep the current tab if it still exists; otherwise land on the first.
      setActiveTierId((prev) =>
        prev && ordered.some((t) => t.id === prev) ? prev : (ordered[0]?.id ?? ''),
      );
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load tiers.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const onDeleteTierConfirmed = async (evidence: ReauthResponse) => {
    if (!deletingTier) return;
    try {
      await tiersApi.remove(deletingTier.id, {
        evidence_id: evidence.evidence_id,
        reason: evidence.comment ?? '',
      });
      toast.success('Tier deleted', { description: deletingTier.name });
      setDeletingTier(null);
      await load();
    } catch (err) {
      toast.error('Delete failed', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  };

  const onDeletePrefixConfirmed = async (evidence: ReauthResponse) => {
    if (!deletingPrefix) return;
    try {
      await tiersApi.removePrefix(deletingPrefix.tier.id, deletingPrefix.prefix.id, {
        evidence_id: evidence.evidence_id,
        reason: evidence.comment ?? '',
      });
      toast.success('Prefix deleted', { description: deletingPrefix.prefix.code });
      setDeletingPrefix(null);
      await load();
    } catch (err) {
      toast.error('Delete failed', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  };

  return (
    <>
      <PageHeader
        title="Item Tiers"
        subtitle="The three item tiers, each with its admin-managed prefixes. Sub-assemblies and finished goods carry a bill of materials; raw materials are bought as-is."
        actions={
          canWriteTiers ? (
            <Button variant="primary" onClick={() => setCreatingTier(true)}>
              <Plus size={14} /> New tier
            </Button>
          ) : undefined
        }
      />

      <div className="flex-1 px-6 py-6 sm:px-8">
        {loadError ? (
          <div className={PANEL}>
            <EmptyState
              title="Couldn't load tiers"
              hint={loadError}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          </div>
        ) : loading && tiers.length === 0 ? (
          <div className={PANEL}>
            <EmptyState title="Loading tiers…" hint="Fetching the item tiers and prefixes." />
          </div>
        ) : tiers.length === 0 ? (
          <div className={PANEL}>
            <EmptyState title="No tiers yet" hint="Create your first item tier." />
          </div>
        ) : (
          <Tabs value={activeTierId} onValueChange={setActiveTierId}>
            <TabsScroller>
              <TabsList>
                {tiers.map((tier) => (
                  <TabsTrigger key={tier.id} value={tier.id}>
                    <span
                      aria-hidden
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        TONE_DOT[(tier.tone as BadgeTone) ?? 'neutral'],
                      )}
                    />
                    {tier.name}
                    <span className="text-xs text-text-3">{tier.prefixes.length}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </TabsScroller>

            {tiers.map((tier) => (
              <TabsContent key={tier.id} value={tier.id}>
                <div className={PANEL}>
                  {/* Tier meta + the contextual "add prefix to THIS tier" action */}
                  <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Badge tone="neutral">{TIER_TYPE_LABELS[tier.type]}</Badge>
                      <span className="text-xs text-text-3">
                        {tier.item_count} item{tier.item_count === 1 ? '' : 's'} across{' '}
                        {tier.prefixes.length} prefix
                        {tier.prefixes.length === 1 ? '' : 'es'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {canManagePrefixes && (
                        <Button variant="primary" className="h-8" onClick={() => setAddingTo(tier)}>
                          <Plus size={14} /> Add prefix
                        </Button>
                      )}
                      {canWriteTiers && (
                        <>
                          <Button
                            variant="ghost"
                            className="h-8 px-2"
                            onClick={() => setEditingTier(tier)}
                            aria-label={`Edit ${tier.name}`}
                          >
                            <Pencil size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            className="h-8 px-2 text-danger"
                            disabled={tier.is_seeded || tier.item_count > 0}
                            title={
                              tier.is_seeded
                                ? 'Seeded tiers cannot be deleted'
                                : tier.item_count > 0
                                  ? 'In use — reassign its items first'
                                  : 'Delete tier'
                            }
                            onClick={() => setDeletingTier(tier)}
                            aria-label={`Delete ${tier.name}`}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {tier.prefixes.length === 0 ? (
                    <EmptyState
                      title="No prefixes yet"
                      hint={
                        canManagePrefixes
                          ? 'Add one so items in this tier can be numbered.'
                          : 'An admin needs to add a prefix before items can be numbered.'
                      }
                    />
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Prefix</TableHead>
                            <TableHead>Label</TableHead>
                            <TableHead className="text-right">Items</TableHead>
                            <TableHead>Default</TableHead>
                            {canManagePrefixes && (
                              <TableHead className="text-right">Actions</TableHead>
                            )}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {tier.prefixes.map((p) => {
                            const inUse = p.item_count > 0;
                            const deleteBlockReason = p.is_seeded
                              ? 'Seeded prefixes cannot be deleted'
                              : inUse
                                ? 'In use — reassign its items first'
                                : p.is_default
                                  ? 'Default prefix — set another as default first'
                                  : 'Delete prefix';
                            return (
                              <TableRow key={p.id}>
                                <TableCell>
                                  <span className="font-mono text-text">{p.code}-</span>
                                </TableCell>
                                <TableCell className="text-text-2">{p.label ?? '—'}</TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  {p.item_count}
                                </TableCell>
                                <TableCell>
                                  {p.is_default ? <Badge tone="accent">default</Badge> : null}
                                </TableCell>
                                {canManagePrefixes && (
                                  <TableCell>
                                    <div className="flex items-center justify-end gap-1">
                                      <Button
                                        variant="ghost"
                                        className="h-8 px-2"
                                        onClick={() => setEditingPrefix({ tier, prefix: p })}
                                        aria-label={`Edit prefix ${p.code}`}
                                      >
                                        <Pencil size={14} />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        className="h-8 px-2 text-danger"
                                        disabled={p.is_seeded || inUse || p.is_default}
                                        title={deleteBlockReason}
                                        onClick={() => setDeletingPrefix({ tier, prefix: p })}
                                        aria-label={`Delete prefix ${p.code}`}
                                      >
                                        <Trash2 size={14} />
                                      </Button>
                                    </div>
                                  </TableCell>
                                )}
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              </TabsContent>
            ))}
          </Tabs>
        )}
      </div>

      {/* Tier create / edit (gated) */}
      <TierFormDialog
        open={creatingTier}
        onOpenChange={setCreatingTier}
        onSaved={() => void load()}
      />
      <TierFormDialog
        open={editingTier !== null}
        onOpenChange={(o) => {
          if (!o) setEditingTier(null);
        }}
        tier={editingTier}
        onSaved={() => void load()}
      />
      <PasswordReauthDialog
        open={deletingTier !== null}
        onOpenChange={(o) => {
          if (!o) setDeletingTier(null);
        }}
        action="tier.delete"
        recordTable="app.item_tiers"
        recordId={deletingTier?.id}
        meaning={deletingTier ? `I am deleting the item tier "${deletingTier.name}".` : ''}
        commentPlaceholder="e.g. No longer used"
        onConfirmed={onDeleteTierConfirmed}
        title="Sign this tier deletion"
        submitLabel="Delete"
      />

      {/* Prefix create / edit / delete */}
      <PrefixFormDialog
        open={addingTo !== null}
        onOpenChange={(o) => {
          if (!o) setAddingTo(null);
        }}
        tierId={addingTo?.id ?? ''}
        tierName={addingTo?.name ?? ''}
        onSaved={() => void load()}
      />
      <PrefixFormDialog
        open={editingPrefix !== null}
        onOpenChange={(o) => {
          if (!o) setEditingPrefix(null);
        }}
        tierId={editingPrefix?.tier.id ?? ''}
        tierName={editingPrefix?.tier.name ?? ''}
        prefix={editingPrefix?.prefix ?? null}
        onSaved={() => void load()}
      />
      <PasswordReauthDialog
        open={deletingPrefix !== null}
        onOpenChange={(o) => {
          if (!o) setDeletingPrefix(null);
        }}
        action="prefix.delete"
        recordTable="app.item_prefixes"
        recordId={deletingPrefix?.prefix.id}
        meaning={
          deletingPrefix
            ? `I am deleting the prefix "${deletingPrefix.prefix.code}" from the ${deletingPrefix.tier.name} tier.`
            : ''
        }
        commentPlaceholder="e.g. Prefix retired"
        onConfirmed={onDeletePrefixConfirmed}
        title="Sign this prefix deletion"
        submitLabel="Delete"
      />
    </>
  );
}
