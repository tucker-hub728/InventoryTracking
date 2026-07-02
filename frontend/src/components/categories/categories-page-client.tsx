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
import { categoriesApi, type ApiCategory } from '@/lib/api/categories';
import { cn } from '@/lib/utils';
import type { BadgeTone } from '@/types/ui';

import { CategoryFormDialog } from './category-form-dialog';

const TONE_DOT: Record<BadgeTone, string> = {
  neutral: 'bg-text-3',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

/**
 * Item Categories admin page. Lists the categories with their kind
 * (Product / Purchased), colour, and item count. Create / edit / delete are
 * electronically signed (via {@link CategoryFormDialog} and the reauth dialog).
 */
export function CategoriesPageClient() {
  const canWrite = usePermission('inventory', 'sign');

  const [categories, setCategories] = React.useState<ApiCategory[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<ApiCategory | null>(null);
  const [deleting, setDeleting] = React.useState<ApiCategory | null>(null);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await categoriesApi.list({ signal });
      setCategories(rows);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load categories.');
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
      await categoriesApi.remove(deleting.id, {
        evidence_id: evidence.evidence_id,
        reason: evidence.comment ?? '',
      });
      toast.success('Category deleted', { description: deleting.name });
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
        title="Item Categories"
        subtitle="Group items by kind. Product categories can carry a bill of materials; Purchased are bought as-is."
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> New category
            </Button>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="p-4">
          {loadError ? (
            <EmptyState
              title="Couldn't load categories"
              hint={loadError}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          ) : !loading && categories.length === 0 ? (
            <EmptyState title="No categories yet" hint="Create your first item category." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                    <th className="px-3 py-2 font-medium">Category</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 text-right font-medium">Items</th>
                    {canWrite && <th className="px-3 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {categories.map((c) => {
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
                          <Badge tone={c.kind === 'built' ? 'accent' : 'neutral'}>
                            {c.kind === 'built' ? 'Product' : 'Purchased'}
                          </Badge>
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
                                    ? 'Seeded categories cannot be deleted'
                                    : inUse
                                      ? 'In use — reassign its items first'
                                      : 'Delete category'
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

      <CategoryFormDialog
        open={creating}
        onOpenChange={setCreating}
        onSaved={() => void load()}
      />
      <CategoryFormDialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        category={editing}
        onSaved={() => void load()}
      />

      <PasswordReauthDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        action="category.delete"
        meaning={
          deleting ? `I am deleting the item category "${deleting.name}".` : ''
        }
        commentPlaceholder="e.g. No longer used"
        onConfirmed={onDeleteConfirmed}
        title="Sign this category deletion"
        submitLabel="Delete"
      />
    </>
  );
}
