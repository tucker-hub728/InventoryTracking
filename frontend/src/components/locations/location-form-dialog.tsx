'use client';

import * as React from 'react';
import { toast } from 'sonner';

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
import { ApiError } from '@/lib/api/client';
import { locationsApi, type ApiLocation } from '@/lib/api/locations';
import { LOCATION_CATEGORIES } from '@/lib/location-categories';

type Mode = 'create' | 'edit';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  /** The location being edited (edit mode). */
  location?: ApiLocation;
  /** When set, the dialog creates a shelf under this parent (category locked). */
  presetParent?: ApiLocation;
  allLocations: ApiLocation[];
  onSaved: () => void;
}

const NO_PARENT = '__none__';

export function LocationFormDialog({
  open,
  onOpenChange,
  mode,
  location,
  presetParent,
  allLocations,
  onSaved,
}: Props) {
  const isShelf = mode === 'edit' && Boolean(location?.parent_location_id);
  const hasChildren =
    mode === 'edit' && allLocations.some((l) => l.parent_location_id === location?.id);

  const [name, setName] = React.useState('');
  const [category, setCategory] = React.useState('');
  const [parentId, setParentId] = React.useState(NO_PARENT);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    if (presetParent) {
      setName('');
      setCategory(presetParent.location_type);
      setParentId(presetParent.id);
    } else if (mode === 'edit' && location) {
      setName(location.location_name);
      setCategory(location.location_type);
      setParentId(location.parent_location_id ?? NO_PARENT);
    } else {
      setName('');
      setCategory('');
      setParentId(NO_PARENT);
    }
  }, [open, mode, location, presetParent]);

  // Category is fixed for a preset shelf, for an existing shelf (must match its
  // parent), and for a top-level that already has shelves (would orphan them).
  const categoryLocked = Boolean(presetParent) || isShelf || hasChildren;

  const onCategoryChange = (next: string) => {
    setCategory(next);
    // Drop a parent that no longer belongs to the selected category.
    if (parentId !== NO_PARENT) {
      const stillValid = allLocations.some(
        (l) => l.id === parentId && l.location_type === next,
      );
      if (!stillValid) setParentId(NO_PARENT);
    }
  };

  // With a parent chosen the record is a shelf/sub-location; otherwise it's a
  // top-level location. Drive the Name field's wording off that.
  const asShelf = parentId !== NO_PARENT;

  const valid = Boolean(name.trim() && category);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    const parent_location_id = parentId === NO_PARENT ? null : parentId;
    try {
      if (mode === 'create') {
        await locationsApi.create({
          location_name: name.trim(),
          location_type: category,
          parent_location_id,
        });
        toast.success(presetParent ? 'Sub-location created' : 'Location created');
      } else if (location) {
        await locationsApi.update(location.id, {
          location_name: name.trim(),
          location_type: category,
          parent_location_id,
        });
        toast.success('Location updated');
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const title =
    mode === 'edit'
      ? `Edit ${location?.location_name ?? 'location'}`
      : presetParent
        ? `Add Sub-Location`
        : 'Add Location';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {presetParent
                ? `Shelf under ${presetParent.location_name} · ${presetParent.location_type}.`
                : mode === 'edit'
                  ? 'Update this location. Categories are pre-defined.'
                  : 'Create a new controlled location. Categories are pre-defined.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="loc_name">{asShelf ? 'Sub-location name' : 'Location name'}</Label>
              <Input
                id="loc_name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={asShelf ? 'e.g., Shelf A' : 'e.g., Materials Management 1'}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="loc_category">Category</Label>
              <Select value={category} onValueChange={onCategoryChange} disabled={categoryLocked}>
                <SelectTrigger id="loc_category" aria-label="Category">
                  <SelectValue placeholder="Select category…" />
                </SelectTrigger>
                <SelectContent>
                  {LOCATION_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Parent is not editable here — a location is top-level, and shelves
                are created via "Add Sub-Location" (which sets the parent). An
                existing shelf keeps its parent unchanged. */}
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid || saving}>
              {saving
                ? 'Saving…'
                : mode === 'edit'
                  ? 'Save'
                  : presetParent
                    ? 'Create sub-location'
                    : 'Create location'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
