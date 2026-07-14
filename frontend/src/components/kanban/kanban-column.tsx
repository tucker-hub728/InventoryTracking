'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { KanbanCard } from './kanban-card';
import { KANBAN_STAGE_BY_ID } from '@/config/inventory';
import type { KanbanStageId } from '@/config/inventory';
import type { InventoryItem } from '@/types/inventory';
import type { BadgeTone } from '@/types/ui';

const DOT_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-text-3',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

interface Props {
  stage: KanbanStageId;
  items: InventoryItem[];
  isDragOver: boolean;
  draggingId: string | null;
  canDrag: boolean;
  onCardClick: (item: InventoryItem) => void;
  onCardDragStart: (id: string) => void;
  onCardDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: () => void;
}

export function KanbanColumn({
  stage,
  items,
  isDragOver,
  draggingId,
  canDrag,
  onCardClick,
  onCardDragStart,
  onCardDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: Props) {
  const meta = KANBAN_STAGE_BY_ID[stage];
  return (
    <section
      aria-label={meta.label}
      className="flex min-w-[260px] flex-col gap-2"
    >
      <header className="flex items-center justify-between px-1.5 pb-1 pt-0.5">
        <div className="inline-flex items-center gap-2">
          <span className={cn('size-2 rounded-full', DOT_TONE[meta.tone])} aria-hidden />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-2">
            {meta.label}
          </span>
        </div>
        <span className="font-mono text-[11px] font-semibold text-text-3">{items.length}</span>
      </header>
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => {
          e.preventDefault();
          onDrop();
        }}
        className={cn(
          'flex min-h-[60vh] flex-1 flex-col gap-2 rounded-md border border-dashed border-transparent p-1.5 transition-colors',
          isDragOver && 'border-accent bg-accent-soft',
        )}
      >
        {items.map((it) => (
          <KanbanCard
            key={it.id}
            item={it}
            stage={stage}
            draggable={canDrag}
            isDragging={draggingId === it.id}
            onClick={() => onCardClick(it)}
            onDragStart={() => onCardDragStart(it.id)}
            onDragEnd={onCardDragEnd}
          />
        ))}
        {items.length === 0 && (
          <div className="grid h-full place-items-center px-2 py-6 text-center text-[11px] text-text-3">
            No items
          </div>
        )}
      </div>
    </section>
  );
}
