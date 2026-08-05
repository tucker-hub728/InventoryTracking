'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/utils';

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      // Triggers never compress — a narrow container scrolls instead, which is
      // what the ``TabsScroller`` wrapper below is for.
      'inline-flex items-center justify-start gap-1 border-b border-border [&>*]:shrink-0',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

/**
 * Wrap a {@link TabsList} so it scrolls sideways instead of clipping its last
 * tabs out of reach on a narrow screen (REQ-2026-07-15-UI-002).
 *
 * A wrapper rather than overflow on the list itself: CSS forces ``overflow-y``
 * to a scrolling value once ``overflow-x`` is one, which would clip each
 * trigger's ``-mb-px`` active underline and its focus ring. The extra bottom
 * pixel here gives them room inside the scroll box.
 */
const TabsScroller = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('scroll-strip pb-px', className)} {...props} />
);
TabsScroller.displayName = 'TabsScroller';

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      '-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3.5 py-2.5 text-sm font-normal text-text-2 outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-text data-[state=active]:font-medium data-[state=active]:text-text',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn('mt-4 focus-visible:outline-none', className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsScroller, TabsTrigger, TabsContent };
