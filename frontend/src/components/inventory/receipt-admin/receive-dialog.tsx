'use client';

import * as React from 'react';
import { ShieldCheck, Split, Trash2 } from 'lucide-react';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { ApiError } from '@/lib/api/client';
import type { ReauthResponse } from '@/lib/api/auth';
import { vendorsApi, type Vendor } from '@/lib/api/vendors';
import {
  receivingApi,
  type ReceiptTransaction,
  type ReceiveInput,
  type ReceiveLineInput,
  type ReceiveSplitInput,
} from '@/lib/api/receiving';

const NEW_VENDOR = '__new__';
// Radix <Select.Item> forbids an empty-string value, so the "same as the
// lot's vendor" choice uses a sentinel (not '').
const SAME_VENDOR = '__same__';

interface SplitDraft {
  key: string;
  received_qty: string;
  isChild: boolean;
  lot_number: string;
  vendorChoice: string; // SAME_VENDOR | vendor id | NEW_VENDOR
  vendor_name: string;
  unit_price: string;
}

let _seq = 0;
function newSplit(child: boolean): SplitDraft {
  _seq += 1;
  return {
    key: `split-${_seq}`,
    received_qty: '',
    isChild: child,
    lot_number: '',
    vendorChoice: SAME_VENDOR,
    vendor_name: '',
    unit_price: '',
  };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: ReceiptTransaction | null;
  onReceived: (txn: ReceiptTransaction) => void;
}

/**
 * Physical receipt (Requirements v2 §5). Per ON_ORDER lot the operator
 * submits one or more splits: the first receives into the original lot
 * (flips it AVAILABLE), the rest create child supplier lots. Every split
 * posts a receipt movement; the whole receipt is covered by one
 * e-signature (action ``receipt.confirm``).
 */
export function ReceiveDialog({ open, onOpenChange, transaction, onReceived }: Props) {
  const [vendors, setVendors] = React.useState<Vendor[]>([]);
  const [splitsByLot, setSplitsByLot] = React.useState<Record<string, SplitDraft[]>>(
    {},
  );
  // The transaction re-fetched fresh when the dialog opens — the list row
  // we were handed can be stale (e.g. its lots weren't hydrated), so we
  // always reload to be sure the ON_ORDER lots are current.
  const [freshTxn, setFreshTxn] = React.useState<ReceiptTransaction | null>(null);
  const [loadingTxn, setLoadingTxn] = React.useState(false);
  const [showReauth, setShowReauth] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const activeTxn = freshTxn ?? transaction;
  const onOrderLots = React.useMemo(
    () => (activeTxn?.lots ?? []).filter((l) => l.status === 'on_order'),
    [activeTxn],
  );

  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoadingTxn(true);
    Promise.all([
      vendorsApi.list({ activeOnly: true, signal: ctrl.signal }),
      transaction
        ? receivingApi.getTransaction(transaction.id, { signal: ctrl.signal })
        : Promise.resolve(null),
    ])
      .then(([vendorList, fresh]) => {
        setVendors(vendorList);
        if (fresh) setFreshTxn(fresh);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setFormError(err instanceof ApiError ? err.message : 'Failed to load data.');
      })
      .finally(() => setLoadingTxn(false));
    return () => ctrl.abort();
  }, [open, transaction]);

  // Seed one "into original lot" split per on-order lot, defaulted to the
  // ordered quantity.
  React.useEffect(() => {
    if (!open) return;
    const seed: Record<string, SplitDraft[]> = {};
    for (const lot of onOrderLots) {
      const first = newSplit(false);
      first.received_qty = lot.ordered_qty ?? '';
      seed[lot.id] = [first];
    }
    setSplitsByLot(seed);
  }, [open, onOrderLots]);

  React.useEffect(() => {
    if (!open) {
      setSplitsByLot({});
      setFreshTxn(null);
      setShowReauth(false);
      setSubmitting(false);
      setFormError(null);
    }
  }, [open]);

  const patchSplit = (lotId: string, key: string, patch: Partial<SplitDraft>) =>
    setSplitsByLot((prev) => ({
      ...prev,
      [lotId]: (prev[lotId] ?? []).map((s) =>
        s.key === key ? { ...s, ...patch } : s,
      ),
    }));

  const addSplit = (lotId: string) =>
    setSplitsByLot((prev) => ({
      ...prev,
      [lotId]: [...(prev[lotId] ?? []), newSplit(true)],
    }));

  const removeSplit = (lotId: string, key: string) =>
    setSplitsByLot((prev) => ({
      ...prev,
      [lotId]: (prev[lotId] ?? []).filter((s) => s.key !== key),
    }));

  const buildPayload = (evidenceId: string): ReceiveInput | null => {
    const lines: ReceiveLineInput[] = [];
    for (const lot of onOrderLots) {
      const drafts = splitsByLot[lot.id] ?? [];
      if (drafts.length === 0) {
        setFormError(`Lot ${lot.lot_number} needs at least one received split.`);
        return null;
      }
      const seenChild = new Set<string>();
      const splits: ReceiveSplitInput[] = [];
      drafts.forEach((d, idx) => {
        const qty = Number(d.received_qty);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new SplitError(`Lot ${lot.lot_number}: received qty must be > 0.`);
        }
        const usingNew = d.vendorChoice === NEW_VENDOR;
        const split: ReceiveSplitInput = { received_qty: qty };
        if (idx > 0) {
          const childNo = d.lot_number.trim();
          if (!childNo) {
            throw new SplitError(
              `Lot ${lot.lot_number}: each additional split needs its own lot number.`,
            );
          }
          if (seenChild.has(childNo.toLowerCase())) {
            throw new SplitError(`Duplicate split lot number "${childNo}".`);
          }
          seenChild.add(childNo.toLowerCase());
          split.lot_number = childNo;
        }
        if (d.vendorChoice && d.vendorChoice !== SAME_VENDOR) {
          if (usingNew) {
            if (!d.vendor_name.trim()) {
              throw new SplitError(`Enter the new vendor name for a split.`);
            }
            split.vendor_name = d.vendor_name.trim();
          } else {
            split.vendor_id = d.vendorChoice;
          }
        }
        if (d.unit_price) split.unit_price = Number(d.unit_price);
        splits.push(split);
      });
      lines.push({ lot_id: lot.id, splits });
    }
    return { lines, evidence_id: evidenceId };
  };

  const submit = async (evidence: ReauthResponse) => {
    if (!transaction) return;
    setSubmitting(true);
    setFormError(null);
    let payload: ReceiveInput | null;
    try {
      payload = buildPayload(evidence.evidence_id);
    } catch (err) {
      setFormError(err instanceof SplitError ? err.message : 'Invalid receive lines.');
      setSubmitting(false);
      return;
    }
    if (!payload) {
      setSubmitting(false);
      return;
    }
    try {
      const updated = await receivingApi.receive(transaction.id, payload);
      toast.success('Receipt confirmed', {
        description: `${updated.item_number ?? ''} — lots are now available`,
      });
      onReceived(updated);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (
          err.code === 'reauth_evidence_replayed' ||
          err.code === 'reauth_evidence_expired'
        ) {
          setFormError('Your signature expired or was already used. Sign again.');
        } else {
          setFormError(err.message);
        }
      } else {
        setFormError('Failed to confirm receipt. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Pre-validate before opening the e-sign dialog so the operator fixes
  // input errors before the password ceremony.
  const openSign = () => {
    setFormError(null);
    try {
      const ok = buildPayload('preview');
      if (!ok) return;
    } catch (err) {
      setFormError(err instanceof SplitError ? err.message : 'Invalid receive lines.');
      return;
    }
    setShowReauth(true);
  };

  const itemLabel = transaction
    ? `${transaction.item_number ?? ''} ${transaction.item_description ?? ''}`.trim()
    : '';
  const attestation = `I attest the physical receipt of ${itemLabel || 'this order'} is accurate and the lots are correct.`;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Confirm physical receipt</DialogTitle>
            <DialogDescription>
              Record what arrived. Adjust received quantities and split a lot into
              multiple supplier lots if needed. On confirmation the lots become
              available and the ledger is updated under your e-signature.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {loadingTxn && onOrderLots.length === 0 && (
              <p className="text-sm text-text-3">Loading lots…</p>
            )}
            {!loadingTxn && onOrderLots.length === 0 && (
              <p className="text-sm text-text-3">
                This transaction has no on-order lots to receive.
              </p>
            )}

            {onOrderLots.map((lot) => {
              const drafts = splitsByLot[lot.id] ?? [];
              return (
                <div
                  key={lot.id}
                  className="rounded-md border border-border bg-surface p-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-sm">
                      <span className="font-mono text-xs text-accent">
                        {lot.lot_number}
                      </span>
                      <span className="ml-2 text-text-3">
                        ordered {lot.ordered_qty ?? '—'} ·{' '}
                        {lot.vendor_name ?? 'no vendor'}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => addSplit(lot.id)}
                    >
                      <Split size={14} /> Split
                    </Button>
                  </div>

                  <div className="space-y-2">
                    {drafts.map((d, idx) => (
                      <div
                        key={d.key}
                        className="rounded border border-border/60 bg-bg-elev p-2.5"
                      >
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="text-xs text-text-3">
                            {idx === 0 ? 'Into original lot' : 'New supplier lot'}
                          </span>
                          {idx > 0 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => removeSplit(lot.id, d.key)}
                              aria-label="Remove split"
                            >
                              <Trash2 size={13} />
                            </Button>
                          )}
                        </div>
                        <div className="grid grid-cols-3 gap-2.5">
                          <div className="space-y-1">
                            <Label className="text-xs">Received qty</Label>
                            <Input
                              type="number"
                              min={0}
                              step="1"
                              value={d.received_qty}
                              onChange={(e) =>
                                patchSplit(lot.id, d.key, {
                                  received_qty: e.target.value,
                                })
                              }
                            />
                          </div>
                          {idx > 0 ? (
                            <div className="space-y-1">
                              <Label className="text-xs">Lot number</Label>
                              <Input
                                className="font-mono"
                                placeholder="L-…-B"
                                value={d.lot_number}
                                onChange={(e) =>
                                  patchSplit(lot.id, d.key, {
                                    lot_number: e.target.value,
                                  })
                                }
                              />
                            </div>
                          ) : (
                            <div className="space-y-1">
                              <Label className="text-xs">Lot number</Label>
                              <Input
                                className="font-mono"
                                value={lot.lot_number}
                                disabled
                              />
                            </div>
                          )}
                          <div className="space-y-1">
                            <Label className="text-xs">Unit price</Label>
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              placeholder={lot.unit_price_amount ?? '0.00'}
                              value={d.unit_price}
                              onChange={(e) =>
                                patchSplit(lot.id, d.key, {
                                  unit_price: e.target.value,
                                })
                              }
                            />
                          </div>
                        </div>

                        <div className="mt-2 space-y-1">
                          <Label className="text-xs">Vendor</Label>
                          <Select
                            value={d.vendorChoice}
                            onValueChange={(v) =>
                              patchSplit(lot.id, d.key, { vendorChoice: v })
                            }
                          >
                            <SelectTrigger aria-label="Split vendor">
                              <SelectValue placeholder="Same as lot vendor" />
                            </SelectTrigger>
                            <SelectContent className="max-h-72">
                              <SelectItem value={SAME_VENDOR}>
                                Same as lot ({lot.vendor_name ?? 'none'})
                              </SelectItem>
                              <SelectItem value={NEW_VENDOR}>+ New vendor…</SelectItem>
                              {vendors.map((v) => (
                                <SelectItem key={v.id} value={v.id}>
                                  {v.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {d.vendorChoice === NEW_VENDOR && (
                            <Input
                              className="mt-1.5"
                              placeholder="New vendor name"
                              value={d.vendor_name}
                              onChange={(e) =>
                                patchSplit(lot.id, d.key, {
                                  vendor_name: e.target.value,
                                })
                              }
                            />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {formError && (
              <p
                role="alert"
                className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
              >
                {formError}
              </p>
            )}
          </DialogBody>

          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={openSign}
              disabled={submitting || loadingTxn || onOrderLots.length === 0}
            >
              <ShieldCheck size={14} /> Sign &amp; receive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={setShowReauth}
        action="receipt.confirm"
        meaning={attestation}
        onConfirmed={submit}
        title="Sign this receipt"
        submitLabel="Sign & receive"
      />
    </>
  );
}

// Thrown inside buildPayload's split loop to bubble a friendly message up
// to the form (kept local — not part of the API surface).
class SplitError extends Error {}
