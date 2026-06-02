'use client';

import { Toaster as SonnerToaster } from 'sonner';

import { useUIStore } from '@/stores/ui.store';

/**
 * Sonner-backed toaster. Position bottom-right (matches legacy behavior),
 * theme follows the UI store so dark/light mode is consistent.
 */
export function Toaster() {
  const theme = useUIStore((s) => s.theme);
  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-bg-elev group-[.toaster]:text-text group-[.toaster]:border-border group-[.toaster]:shadow-elev-md',
          description: 'group-[.toast]:text-text-2',
          actionButton: 'group-[.toast]:bg-accent group-[.toast]:text-white',
          cancelButton: 'group-[.toast]:bg-surface-2 group-[.toast]:text-text-2',
        },
      }}
    />
  );
}

export { toast } from 'sonner';
