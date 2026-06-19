'use client';

import * as React from 'react';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import {
  locationNodesApi,
  CHILD_TYPE_OF,
  FLAT_CATEGORIES,
  FLAT_CATEGORY_LABEL,
  NODE_TYPE_LABEL,
  type FlatCategory,
  type LocationNode,
  type NodeType,
} from '@/lib/api/location-nodes';

type Mode =
  | { kind: 'ln2-root' }
  | { kind: 'child'; parent: LocationNode }
  | { kind: 'flat' };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  onCreated: (node: LocationNode) => void;
}

/**
 * Temporary client-side code generator. The Code field was removed from the
 * UI — only the name is user-entered — but the backend still requires a
 * non-blank code that's unique among siblings. We synthesise one from the
 * name plus a short random suffix until code generation moves server-side.
 * The code is never shown anywhere in the UI.
 */
function autoCode(name: string): string {
  const base = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/(^-+)|(-+$)/g, '')
    .slice(0, 50);
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `${base || 'NODE'}-${suffix}`;
}

/** Create a tank quadrant (root), an LN2 child node (type derived from the
 *  parent so the strict hierarchy can't be violated), or a flat location. */
export function NodeCreateDialog({ open, onOpenChange, mode, onCreated }: Props) {
  const [name, setName] = React.useState('');
  const [flatCategory, setFlatCategory] = React.useState<FlatCategory>('kanban');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setName('');
      setFlatCategory('kanban');
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  const nodeType: NodeType | null =
    mode.kind === 'ln2-root'
      ? 'tank_quadrant'
      : mode.kind === 'flat'
        ? 'flat'
        : CHILD_TYPE_OF[mode.parent.node_type];

  const title =
    mode.kind === 'ln2-root'
      ? 'Add Tank Quadrant'
      : mode.kind === 'flat'
        ? 'Add flat location'
        : `Add ${nodeType ? NODE_TYPE_LABEL[nodeType] : 'child'}`;

  const submit = async () => {
    if (!nodeType) return;
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setSubmitting(true);
    try {
      const node = await locationNodesApi.create({
        node_type: nodeType,
        // Code is auto-generated for now and hidden from the UI; the backend
        // will own code generation later. Only the name is user-entered.
        code: autoCode(name),
        name: name.trim(),
        parent_id: mode.kind === 'child' ? mode.parent.id : null,
        flat_category: mode.kind === 'flat' ? flatCategory : null,
      });
      toast.success(`${NODE_TYPE_LABEL[nodeType]} created`, {
        description: node.name,
      });
      onCreated(node);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create node.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode.kind === 'child'
              ? `Under ${NODE_TYPE_LABEL[mode.parent.node_type]} ${mode.parent.name}. Type is fixed by the hierarchy.`
              : mode.kind === 'flat'
                ? 'A standalone operational location — no hierarchy.'
                : 'A top-level LN2 node. Build the hierarchy down to sub-slots.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {mode.kind === 'flat' && (
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select
                value={flatCategory}
                onValueChange={(v) => setFlatCategory(v as FlatCategory)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FLAT_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {FLAT_CATEGORY_LABEL[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>
              Name <span className="text-danger">*</span>
            </Label>
            <Input
              autoFocus
              placeholder="Human label"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
            >
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
