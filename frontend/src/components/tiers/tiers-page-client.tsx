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
import { tiersApi, type ApiTier } from '@/lib/api/tiers';
import { cn } from '@/lib/utils';
import type { BadgeTone } from '@/types/ui';

import { TierFormDialog } from './tier-form-dialog';

const TONE_DOT: Record<BadgeTone, string> = {
  neutral: 'bg-text-3',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

// Tiers are seed-only for now — hide create / edit / delete until the
// admin CRUD flow is turned on. Flip to `true` to restore the write actions.
const TIER_ACTIONS_ENABLED = false;

/**
 * Item Tiers admin page. Lists the tiers with their kind
 * (raw material / sub-assembly / finished good), colour, and item count. Create / edit / delete are
 * electronically signed (via {@link TierFormDialog} and the reauth dialog).
 */
export function TiersPageClient() {
  const canWrite = usePermission('inventory', 'sign') && TIER_ACTIONS_ENABLED;

  const [tiers, setTiers] = React.useState<ApiTier[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<ApiTier | null>(null);
  const [deleting, setDeleting] = React.useState<ApiTier | null>(null);

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

  const onDeleteConfirmed = async (evidence: ReauthResponse) => {
    if (!deleting) return;
    try {
      await tiersApi.remove(deleting.id, {
        evidence_id: evidence.evidence_id,
        reason: evidence.comment ?? '',
      });
      toast.success('Tier deleted', { description: deleting.name });
      setDeleting(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error('Delete failed', { description: err.message });
      } else {
        toast.error('Delete failed');
      }
    }
  };

  return (
    <>
      <PageHeader
        title="Item Tiers"
        subtitle="The three item tiers. Sub-assemblies and finished goods carry a bill of materials; raw materials are bought as-is."
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> New tier
            </Button>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="p-4">
          {loadError ? (
            <EmptyState
              title="Couldn't load tiers"
              hint={loadError}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          ) : !loading && tiers.length === 0 ? (
            <EmptyState title="No tiers yet" hint="Create your first item tier." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                    <th className="px-3 py-2 font-medium">Tier</th>
                    <th className="px-3 py-2 font-medium">Prefix</th>
                    <th className="px-3 py-2 text-right font-medium">Items</th>
                    {canWrite && <th className="px-3 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((c) => {
                    const inUse = c.item_count > 0;
                    return (
                      <tr
                        key={c.id}
                        className="border-b border-border/60 transition-colors hover:bg-surface"
                      >
                        <td className="px-3 py-2.5">
                          <span className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className={cn(
                                'size-2 shrink-0 rounded-full',
                                TONE_DOT[(c.tone as BadgeTone) ?? 'neutral'],
                              )}
                            />
                            <span className="font-medium text-text">{c.name}</span>
                            {c.is_seeded && (
                              <Badge tone="neutral">seeded</Badge>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="font-mono text-xs text-text-2">{c.prefix}-</span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">
                          {c.item_count}
                        </td>
                        {canWrite && (
                          <td className="px-3 py-2.5">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                className="h-8 px-2"
                                onClick={() => setEditing(c)}
                                aria-label={`Edit ${c.name}`}
                              >
                                <Pencil size={14} />
                              </Button>
                              <Button
                                variant="ghost"
                                className="h-8 px-2 text-danger"
                                disabled={c.is_seeded || inUse}
                                title={
                                  c.is_seeded
                                    ? 'Seeded tiers cannot be deleted'
                                    : inUse
                                      ? 'In use — reassign its items first'
                                      : 'Delete tier'
                                }
                                onClick={() => setDeleting(c)}
                                aria-label={`Delete ${c.name}`}
                              >
                                <Trash2 size={14} />
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <TierFormDialog
        open={creating}
        onOpenChange={setCreating}
        onSaved={() => void load()}
      />
      <TierFormDialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        tier={editing}
        onSaved={() => void load()}
      />

      <PasswordReauthDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        action="tier.delete"
        meaning={
          deleting ? `I am deleting the item tier "${deleting.name}".` : ''
        }
        commentPlaceholder="e.g. No longer used"
        onConfirmed={onDeleteConfirmed}
        title="Sign this tier deletion"
        submitLabel="Delete"
      />
    </>
  );
}
