'use client';

import * as React from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/empty-state';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { toast } from '@/components/ui/sonner';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import { tiersApi, TIER_TYPE_LABELS, type ApiPrefix, type ApiTier } from '@/lib/api/tiers';
import { cn } from '@/lib/utils';
import type { BadgeTone } from '@/types/ui';

import { TierFormDialog } from './tier-form-dialog';
import { PrefixFormDialog } from './prefix-form-dialog';

const TONE_DOT: Record<BadgeTone, string> = {
  neutral: 'bg-text-3',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

// Tiers are seed-only for now — the set is fixed at exactly three
// (REQ-2026-07-15-ITM-001), so tier create / edit / delete stay hidden. Prefix
// management (below) is the live admin surface. Flip to restore tier writes.
const TIER_ACTIONS_ENABLED = false;

/** Tier + prefix pair, used to key the prefix edit / delete dialogs. */
interface PrefixRef {
  tier: ApiTier;
  prefix: ApiPrefix;
}

/**
 * Item Tiers admin page. Lists the three tiers and, nested inside each, its
 * admin-managed prefixes (REQ-2026-07-15-ITM-002). Prefix create / edit /
 * delete are electronically signed (via {@link PrefixFormDialog} and the reauth
 * dialog). Tier writes are gated behind {@link TIER_ACTIONS_ENABLED}.
 */
export function TiersPageClient() {
  const canWriteTiers = usePermission('inventory', 'sign') && TIER_ACTIONS_ENABLED;
  const canManagePrefixes = usePermission('inventory', 'sign');

  const [tiers, setTiers] = React.useState<ApiTier[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

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
      setTiers(rows);
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

      <div className="space-y-4 px-6 py-5 sm:px-8">
        {loadError ? (
          <Card className="p-4">
            <EmptyState
              title="Couldn't load tiers"
              hint={loadError}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          </Card>
        ) : !loading && tiers.length === 0 ? (
          <Card className="p-4">
            <EmptyState title="No tiers yet" hint="Create your first item tier." />
          </Card>
        ) : (
          tiers.map((tier) => (
            <Card key={tier.id} className="p-4">
              {/* Tier header */}
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      TONE_DOT[(tier.tone as BadgeTone) ?? 'neutral'],
                    )}
                  />
                  <span className="font-medium text-text">{tier.name}</span>
                  <Badge tone="neutral">{TIER_TYPE_LABELS[tier.type]}</Badge>
                  <span className="text-xs text-text-3">
                    {tier.item_count} item{tier.item_count === 1 ? '' : 's'}
                  </span>
                </span>
                <div className="flex items-center gap-1">
                  {canManagePrefixes && (
                    <Button variant="default" className="h-8" onClick={() => setAddingTo(tier)}>
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

              {/* Prefixes */}
              <div className="mt-3 border-t border-border/60 pt-3">
                {tier.prefixes.length === 0 ? (
                  <p className="text-xs text-text-3">
                    No prefixes yet.{' '}
                    {canManagePrefixes
                      ? 'Add one so items in this tier can be numbered.'
                      : ''}
                  </p>
                ) : (
                  <ul className="space-y-1">
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
                        <li
                          key={p.id}
                          className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-surface"
                        >
                          <span className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className={cn(
                                'size-2 shrink-0 rounded-full',
                                TONE_DOT[(p.tone as BadgeTone) ?? 'neutral'],
                              )}
                            />
                            <span className="font-mono text-sm text-text-2">{p.code}-</span>
                            {p.label && <span className="text-xs text-text-3">{p.label}</span>}
                            {p.is_default && <Badge tone="accent">default</Badge>}
                            <span className="text-xs text-text-3">
                              {p.item_count} item{p.item_count === 1 ? '' : 's'}
                            </span>
                          </span>
                          {canManagePrefixes && (
                            <div className="flex items-center gap-1">
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
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </Card>
          ))
        )}
      </div>

      {/* Tier create / edit (gated) */}
      <TierFormDialog open={creatingTier} onOpenChange={setCreatingTier} onSaved={() => void load()} />
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
