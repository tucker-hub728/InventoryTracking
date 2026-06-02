'use client';

import * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  icon?: LucideIcon;
  /** Render an element on the right (e.g. clear button). */
  trailing?: React.ReactNode;
  /** Wrapper className (icon + input shell). */
  wrapperClassName?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', icon: Icon, trailing, wrapperClassName, disabled, ...props }, ref) => {
    return (
      <div
        className={cn(
          'inline-flex h-8 w-full items-center gap-2 rounded-md border border-border-strong bg-bg-elev px-2.5 text-text-2 transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20',
          disabled && 'bg-surface opacity-60',
          wrapperClassName,
        )}
      >
        {Icon && <Icon size={14} aria-hidden className="shrink-0" />}
        <input
          ref={ref}
          type={type}
          disabled={disabled}
          className={cn(
            'h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-text outline-none placeholder:text-text-3 disabled:cursor-not-allowed',
            className,
          )}
          {...props}
        />
        {trailing}
      </div>
    );
  },
);
Input.displayName = 'Input';

export { Input };
