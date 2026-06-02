'use client';

import * as React from 'react';
import { Settings2 } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { mockData } from '@/lib/mock-data';
import { usePermission } from '@/hooks/use-permission';
import { toast } from '@/components/ui/sonner';
import { KANBAN_STAGES, type KanbanStageId } from '@/config/inventory';
import { KanbanColumn } from './kanban-column';
import { KanbanItemSheet } from './kanban-item-sheet';
import { buildInitialBoard } from './kanban-data';
import type { InventoryItem } from '@/types/inventory';

export function KanbanBoardClient() {
  const items = mockData.items;
  const canEdit = usePermission('inventory', 'edit');

  const [board, setBoard] = React.useState<Record<string, KanbanStageId>>(() =>
    buildInitialBoard(),
  );
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState<KanbanStageId | null>(null);
  const [selection, setSelection] = React.useState<{
    item: InventoryItem;
    stage: KanbanStageId;
  } | null>(null);

  const byStage = React.useMemo(() => {
    const map: Record<KanbanStageId, InventoryItem[]> = Object.fromEntries(
      KANBAN_STAGES.map((s) => [s.id, []]),
    ) as never;
    for (const it of items) {
      const stage = board[it.id];
      if (stage) map[stage].push(it);
    }
    return map;
  }, [board, items]);

  const moveTo = React.useCallback(
    (toStage: KanbanStageId) => {
      if (!draggingId) return;
      const fromStage = board[draggingId];
      setDraggingId(null);
      setDragOver(null);
      if (!fromStage || fromStage === toStage) return;
      if (!canEdit) {
        toast.error('Read-only — cannot move cards');
        return;
      }
      setBoard((b) => ({ ...b, [draggingId]: toStage }));
      const stageLabel = KANBAN_STAGES.find((s) => s.id === toStage)?.label;
      toast.success(`${draggingId} moved to ${stageLabel}`);
    },
    [board, draggingId, canEdit],
  );

  return (
    <>
      <PageHeader
        title="Kanban Workflow"
        subtitle="Inventory lifecycle management"
        actions={
          <Button>
            <Settings2 size={14} /> Configure columns
          </Button>
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <div className="grid auto-cols-fr grid-flow-col gap-3 overflow-x-auto pb-4">
          {KANBAN_STAGES.map((s) => (
            <KanbanColumn
              key={s.id}
              stage={s.id}
              items={byStage[s.id]}
              isDragOver={dragOver === s.id}
              draggingId={draggingId}
              canDrag={canEdit}
              onCardClick={(item) => setSelection({ item, stage: s.id })}
              onCardDragStart={(id) => setDraggingId(id)}
              onCardDragEnd={() => {
                setDraggingId(null);
                setDragOver(null);
              }}
              onDragOver={(e) => {
                if (!draggingId || board[draggingId] === s.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dragOver !== s.id) setDragOver(s.id);
              }}
              onDragLeave={() => {
                if (dragOver === s.id) setDragOver(null);
              }}
              onDrop={() => moveTo(s.id)}
            />
          ))}
        </div>
      </div>

      <KanbanItemSheet
        open={Boolean(selection)}
        onOpenChange={(o) => !o && setSelection(null)}
        selection={selection}
      />
    </>
  );
}
