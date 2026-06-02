'use client';

import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { assigneeFor, priorityFor, reasonFor } from './kanban-data';
import type { KanbanStageId } from '@/config/inventory';
import type { InventoryItem } from '@/types/inventory';

interface Props {
  item: InventoryItem;
  stage: KanbanStageId;
  draggable: boolean;
  isDragging: boolean;
  onClick: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export const KanbanCard = React.memo(function KanbanCard({
  item,
  stage,
  draggable,
  isDragging,
  onClick,
  onDragStart,
  onDragEnd,
}: Props) {
  const priority = priorityFor(item);
  const reason = reasonFor(item, stage);
  const assignee = assigneeFor(item);

  return (
    <article
      role="button"
      tabIndex={0}
      draggable={draggable}
      aria-grabbed={isDragging}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      onDragStart={(e) => {
        if (!draggable) return e.preventDefault();
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group cursor-pointer rounded-md border border-border bg-bg-elev p-3 shadow-elev-sm transition-all hover:shadow-elev-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        isDragging && 'opacity-50 scale-[0.98]',
        draggable && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-tight">{item.desc}</div>
          <div className="mt-1 font-mono text-[11px] text-text-3">{item.id}</div>
        </div>
        <Badge tone={priority.tone}>{priority.label}</Badge>
      </div>
      <div className="mt-2 text-xs text-text-2">{reason}</div>
      <div className="mt-3 flex items-center justify-between text-[11px] text-text-3">
        <span className="font-mono">{item.vendor}</span>
        <Avatar className="size-5 text-[9px]">
          <AvatarFallback>{assignee.initials}</AvatarFallback>
        </Avatar>
      </div>
    </article>
  );
});
