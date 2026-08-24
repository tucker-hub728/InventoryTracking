import { PlanningShell } from '@/components/planning/planning-shell';

/** Header + tab strip shared by both Reorder tabs, so they survive navigation
 *  between the two routes. */
export default function PlanningLayout({ children }: { children: React.ReactNode }) {
  return <PlanningShell>{children}</PlanningShell>;
}
