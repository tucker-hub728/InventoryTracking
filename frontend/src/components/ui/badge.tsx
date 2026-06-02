import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import type { BadgeTone } from '@/types/ui';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 py-0.5 text-xs font-medium leading-none',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-surface-2 text-text-2',
        accent: 'border-accent/30 bg-accent-soft text-accent',
        success: 'border-success/30 bg-success-soft text-success',
        warning: 'border-warning/30 bg-warning-soft text-warning',
        danger: 'border-danger/30 bg-danger-soft text-danger',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

const DOT_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-text-3',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export interface BadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
  children: React.ReactNode;
}

function Badge({ className, tone = 'neutral', dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && (
        <span
          aria-hidden
          className={cn('size-1.5 rounded-full', DOT_TONE[tone ?? 'neutral'])}
        />
      )}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
