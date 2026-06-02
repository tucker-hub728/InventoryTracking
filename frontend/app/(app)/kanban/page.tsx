import type { Metadata } from 'next';

import { KanbanBoardClient } from '@/components/kanban/kanban-board';

export const metadata: Metadata = {
  title: 'Kanban Workflow',
};

export default function KanbanPage() {
  return <KanbanBoardClient />;
}
