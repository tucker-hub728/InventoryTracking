'use client';

import * as React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Render the confirm button in the danger style (delete / destructive). */
  destructive?: boolean;
}

/**
 * App-wide confirmation dialog. Prefer this over the native ``window.confirm``
 * everywhere — it matches the design system and is keyboard / a11y friendly.
 *
 * Imperative usage (the common case):
 * ```tsx
 * const { confirm, confirmDialog } = useConfirm();
 * // …
 * if (await confirm({ title: 'Delete order?', destructive: true })) doDelete();
 * // render once near the root of the component:
 * return <>{…}{confirmDialog}</>;
 * ```
 */
export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmDialog: React.ReactNode;
} {
  const [state, setState] = React.useState<
    (ConfirmOptions & { resolve: (value: boolean) => void }) | null
  >(null);

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setState({ ...options, resolve })),
    [],
  );

  // Resolve the pending promise and close. Reads the latest state via the
  // functional updater so concurrent opens can't strand a promise.
  const settle = React.useCallback((result: boolean) => {
    setState((current) => {
      current?.resolve(result);
      return null;
    });
  }, []);

  const confirmDialog = (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{state?.title}</DialogTitle>
          {state?.description != null && (
            <DialogDescription>{state.description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={() => settle(false)}>
            {state?.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            type="button"
            variant={state?.destructive ? 'danger' : 'primary'}
            onClick={() => settle(true)}
          >
            {state?.confirmLabel ?? 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, confirmDialog };
}
