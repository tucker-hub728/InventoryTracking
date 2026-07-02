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
  type OrderUpdateInput,
} from '@/lib/api/receiving';

import {
  OrderForm,
  emptyFormState,
  formStateFromOrder,
  useItemsList,
  validateOrderForm,
  type OrderFormState,
} from './order-form';

interface Props {
  order: Order | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (order: Order) => void;
}

/**
 * Edit Order dialog (Receipt Admin v3). Edits the header + item lines of an
 * un-received Order (``status === 'open'``). Replaces the whole line set. Not
 * e-signed — a plain edit, no reauth.
 */
export function OrderEditDialog({ order, onOpenChange, onSaved }: Props) {
  const open = order !== null;
  const { items, loading: itemsLoading, error: itemsError } = useItemsList(open);
  const [state, setState] = React.useState<OrderFormState>(emptyFormState);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // Seed the form whenever an order is opened for editing.
  React.useEffect(() => {
    if (!order) return;
    setState(formStateFromOrder(order));
    setSubmitting(false);
    setFormError(null);
  }, [order]);

  const submit = async () => {
    if (!order) return;
    setFormError(null);
    const result = validateOrderForm(state);
    if ('error' in result) {
      setFormError(result.error);
      return;
    }
    const payload: OrderUpdateInput = {
      po_reference: state.po_reference.trim(),
      is_blanket: state.is_blanket,
      valid_from: state.is_blanket ? state.valid_from || null : null,
      valid_to: state.is_blanket ? state.valid_to || null : null,
      lines: result.lines,
    };
    setSubmitting(true);
    try {
      const updated = await receivingApi.updateOrder(order.id, payload);
      toast.success('Order updated', { description: updated.po_reference });
      onSaved(updated);
      onOpenChange(false);
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : 'Failed to update order. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Order</DialogTitle>
          <DialogDescription>
            {order ? (
              <>
                <span className="font-mono text-accent">{order.po_reference}</span> ·
                Edit the header and item lines. Only available while the order is
                open (nothing received yet).
              </>
            ) : (
              ''
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <OrderForm
            items={items}
            itemsLoading={itemsLoading}
            state={state}
            setState={setState}
            idPrefix="edit-order"
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
            {submitting ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
