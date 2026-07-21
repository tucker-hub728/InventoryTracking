'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { StatusBadge } from '@/components/shared/status-badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { KANBAN_STAGE_BY_ID, type KanbanStageId } from '@/config/inventory';
import { assigneeFor, priorityFor, reasonFor } from './kanban-data';
import type { InventoryItem } from '@/types/inventory';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selection: { item: InventoryItem; stage: KanbanStageId } | null;
}

export function KanbanItemSheet({ open, onOpenChange, selection }: Props) {
  if (!selection) return null;
  const { item, stage } = selection;
  const meta = KANBAN_STAGE_BY_ID[stage];
  const priority = priorityFor(item);
  const assignee = assigneeFor(item);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetDescription>{item.id}</SheetDescription>
          <SheetTitle>{item.desc}</SheetTitle>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            <Badge tone={priority.tone}>{priority.label}</Badge>
            <StatusBadge status={item.status} />
          </div>
        </SheetHeader>
        <SheetBody className="space-y-5">
          <div className="rounded-md border border-border bg-surface p-4 text-sm">
            <div className="text-text-2">{reasonFor(item, stage)}</div>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Supplier" value={item.supplier} />
            <Field label="On hand" value={String(item.qty)} mono />
            <Field label="On PO" value={String(item.onOrder)} mono />
            <Field label="Threshold" value={String(item.threshold)} mono />
            <Field label="Lead time" value={`${item.lead}d`} mono />
            <Field label="Location" value={item.location} mono />
            <Field label="Lot" value={item.lot} mono />
          </dl>

          <Separator />

          <div className="flex items-center gap-3">
            <Avatar className="size-8 text-xs">
              <AvatarFallback>{assignee.initials}</AvatarFallback>
            </Avatar>
            <div className="text-sm">
              <div className="font-medium">{assignee.name}</div>
              <div className="text-xs text-text-3">Assigned</div>
            </div>
          </div>
        </SheetBody>
        <SheetFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button asChild variant="primary">
            <Link href={`/inventory/${item.uuid}`}>
              Open item <ArrowRight size={14} />
            </Link>
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-text-3">{label}</dt>
      <dd className={mono ? 'mt-0.5 font-mono text-sm font-medium' : 'mt-0.5 text-sm font-medium'}>
        {value}
      </dd>
    </div>
  );
}
