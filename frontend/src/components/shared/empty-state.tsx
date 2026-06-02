import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  hint,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-5 py-16 text-center text-text-3',
        className,
      )}
    >
      <div className="inline-flex rounded-md bg-surface p-3">
        <Icon className="size-5" aria-hidden />
      </div>
      <div>
        <div className="text-sm font-medium text-text">{title}</div>
        {hint && <div className="mt-1 text-sm">{hint}</div>}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
