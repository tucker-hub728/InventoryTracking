'use client';

import * as React from 'react';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import {
  receivingApi,
  type Order,
  type OrderCreateInput,
} from '@/lib/api/receiving';

import {
  OrderForm,
  emptyFormState,
  useItemsList,
  validateOrderForm,
  type OrderFormState,
} from './order-form';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (order: Order) => void;
}

/**
 * New Order dialog (Receipt Admin v3). Creates an Order header with one-or-more
 * item lines (item, vendor, ordered qty, unit price). No lots / dates are
 * captured here — lots are created later at each dated receive event. Not
 * e-signed.
 */
export function ReceiptIntakeDialog({ open, onOpenChange, onCreated }: Props) {
  const { items, loading: itemsLoading, error: itemsError } = useItemsList(open);
  const [state, setState] = React.useState<OrderFormState>(emptyFormState);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setState(emptyFormState());
      setSubmitting(false);
      setFormError(null);
    }
  }, [open]);

  const submit = async () => {
    setFormError(null);
    const result = validateOrderForm(state);
    if ('error' in result) {
      setFormError(result.error);
      return;
    }
    const payload: OrderCreateInput = {
      po_reference: state.po_reference.trim(),
      is_blanket: state.is_blanket,
      valid_from: state.is_blanket ? state.valid_from || undefined : undefined,
      valid_to: state.is_blanket ? state.valid_to || undefined : undefined,
      lines: result.lines,
    };
    setSubmitting(true);
    try {
      const created = await receivingApi.createOrder(payload);
      toast.success('Order created', {
        description: `${created.po_reference} · ${created.lines.length} item line(s)`,
      });
      onCreated(created);
      onOpenChange(false);
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : 'Failed to create order. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New Order</DialogTitle>
          <DialogDescription>
            Place an order with one or more item lines. Lots, quantities received
            and dates are captured later at each dated receive event.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <OrderForm
            items={items}
            itemsLoading={itemsLoading}
            state={state}
            setState={setState}
            idPrefix="new-order"
          />

          {(formError || itemsError) && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
            >
              {formError ?? itemsError}
            </p>
          )}
        </DialogBody>

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
