'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowDownLeft, ArrowUp, ArrowUpRight, ShieldCheck } from 'lucide-react';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { SignaturePad } from '@/components/shared/signature-pad';
import { useAuthStore } from '@/stores/auth.store';
import { cn, formatNumber } from '@/lib/utils';
import { toast } from '@/components/ui/sonner';
import type { InventoryItem } from '@/types/inventory';

const TOTAL_STEPS = 4;

const schema = z
  .object({
    direction: z.enum(['in', 'out']),
    date: z.string().min(1, 'Date is required'),
    qty: z.coerce.number().int().positive('Quantity must be > 0'),
    location: z.string().min(1, 'Location is required'),
    lot: z.string().min(1, 'Lot number is required'),
    expires: z.string().optional(),
    reason: z.string().min(3, 'Reason is required'),
    intent: z.boolean(),
    username: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
    signatureData: z.string().optional(),
    acknowledged: z.boolean(),
  })
  .refine((d) => d.intent === true, {
    path: ['intent'],
    message: 'Acknowledge that this action requires sign-off',
  })
  .refine((d) => d.acknowledged === true, {
    path: ['acknowledged'],
    message: 'You must acknowledge the audit record statement',
  })
  .refine((d) => (d.signatureData?.length ?? 0) > 0, {
    path: ['signatureData'],
    message: 'A drawn signature is required',
  });

type Values = z.infer<typeof schema>;

const STEP_FIELDS: Record<number, Array<keyof Values>> = {
  1: ['direction', 'date', 'qty'],
  2: ['location', 'lot', 'expires', 'reason'],
  3: ['intent'],
  4: ['username', 'password', 'signatureData', 'acknowledged'],
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: InventoryItem;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

export function RecordMovementDialog({ open, onOpenChange, item }: Props) {
  const user = useAuthStore((s) => s.user);
  const [step, setStep] = React.useState(1);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      direction: 'in',
      date: todayIso(),
      qty: 1,
      location: item.location !== '—' ? item.location : '',
      lot: item.lot !== '—' ? item.lot : '',
      expires: item.expires !== '—' ? item.expires : '',
      reason: '',
      intent: false,
      username: user?.email ?? '',
      password: '',
      signatureData: '',
      acknowledged: false,
    },
  });

  React.useEffect(() => {
    if (!open) {
      setStep(1);
      reset({
        direction: 'in',
        date: todayIso(),
        qty: 1,
        location: item.location !== '—' ? item.location : '',
        lot: item.lot !== '—' ? item.lot : '',
        expires: item.expires !== '—' ? item.expires : '',
        reason: '',
        intent: false,
        username: user?.email ?? '',
        password: '',
        signatureData: '',
        acknowledged: false,
      });
    }
  }, [open, reset, item, user]);

  const direction = watch('direction');
  const qty = Number(watch('qty')) || 0;
  const date = watch('date');
  const location = watch('location');
  const lot = watch('lot');
  const expires = watch('expires');
  const reason = watch('reason');
  const intent = watch('intent');
  const acknowledged = watch('acknowledged');
  const signatureData = watch('signatureData');

  const insufficient = direction === 'out' && qty > item.qty;
  const newBalance =
    direction === 'in' ? item.qty + qty : Math.max(0, item.qty - qty);
  const delta = direction === 'in' ? qty : -qty;

  const next = async () => {
    const fields = STEP_FIELDS[step] ?? [];
    const ok = await trigger(fields, { shouldFocus: true });
    if (!ok) return;
    if (step === 1 && insufficient) return;
    if (step < TOTAL_STEPS) setStep((s) => s + 1);
  };
  const back = () => setStep((s) => Math.max(1, s - 1));

  const onSubmit = async (data: Values): Promise<void> => {
    await new Promise((r) => setTimeout(r, 350));
    toast.success('Movement recorded', {
      description: `${data.direction === 'in' ? 'Stock in' : 'Stock out'} · ${formatNumber(data.qty)} units · signed by ${user?.name}`,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span
                className="grid size-7 place-items-center rounded-full bg-success-soft text-success"
                aria-hidden
              >
                <ArrowUp size={14} />
              </span>
              Record Stock Movement
            </DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div className="text-xs text-text-3">
              Step {step} of {TOTAL_STEPS}
            </div>

            <ItemSummary item={item} />

            {step === 1 && (
              <StepDirection
                direction={direction}
                onDirection={(d) =>
                  setValue('direction', d, { shouldValidate: true })
                }
                date={date}
                registerDate={register('date')}
                registerQty={register('qty')}
                qty={qty}
                qtyError={errors.qty?.message}
                dateError={errors.date?.message}
                item={item}
                newBalance={newBalance}
                delta={delta}
                insufficient={insufficient}
              />
            )}

            {step === 2 && (
              <StepLogistics
                register={register}
                errors={{
                  location: errors.location?.message,
                  lot: errors.lot?.message,
                  expires: errors.expires?.message,
                  reason: errors.reason?.message,
                }}
              />
            )}

            {step === 3 && (
              <StepReview
                item={item}
                values={{ direction, qty, lot, expires, location, reason }}
                intent={intent}
                onIntent={(v) =>
                  setValue('intent', v, { shouldValidate: true })
                }
                error={errors.intent?.message}
              />
            )}

            {step === 4 && (
              <StepSignoff
                registerUser={register('username')}
                registerPw={register('password')}
                username={watch('username')}
                reason={reason}
                signatureData={signatureData ?? ''}
                onSignature={(d) =>
                  setValue('signatureData', d, { shouldValidate: true })
                }
                acknowledged={acknowledged}
                onAck={(v) =>
                  setValue('acknowledged', v, { shouldValidate: true })
                }
                errors={{
                  username: errors.username?.message,
                  password: errors.password?.message,
                  signatureData: errors.signatureData?.message,
                  acknowledged: errors.acknowledged?.message,
                }}
              />
            )}
          </DialogBody>

          <DialogFooter>
            {step > 1 && (
              <Button type="button" variant="default" onClick={back} className="mr-auto">
                ← Back
              </Button>
            )}
            <Button type="button" variant="default" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {step < TOTAL_STEPS ? (
              <Button
                type="button"
                variant="primary"
                onClick={next}
                disabled={step === 1 && insufficient}
              >
                {step === 3 ? 'Proceed to Sign-off' : 'Continue'}
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={isSubmitting}>
                <ShieldCheck size={14} />
                {isSubmitting ? 'Signing…' : 'Sign & Submit'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ───────── Sub-components ─────────

function ItemSummary({ item }: { item: InventoryItem }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{item.desc}</div>
        <div className="mt-0.5 truncate font-mono text-xs text-text-3">
          {item.id} · {item.vendor}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[11px] text-text-3">Current bal.</div>
        <div className="font-mono text-base font-semibold">{formatNumber(item.qty)}</div>
      </div>
    </div>
  );
}

function StepDirection({
  direction,
  onDirection,
  date,
  registerDate,
  registerQty,
  qty,
  qtyError,
  dateError,
  item,
  newBalance,
  delta,
  insufficient,
}: {
  direction: 'in' | 'out';
  onDirection: (d: 'in' | 'out') => void;
  date: string;
  registerDate: ReturnType<ReturnType<typeof useForm<Values>>['register']>;
  registerQty: ReturnType<ReturnType<typeof useForm<Values>>['register']>;
  qty: number;
  qtyError?: string;
  dateError?: string;
  item: InventoryItem;
  newBalance: number;
  delta: number;
  insufficient: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Direction</Label>
        <div className="grid grid-cols-2 gap-2">
          <DirectionPill
            active={direction === 'in'}
            tone="success"
            icon={<ArrowDownLeft size={13} />}
            label="Stock In (Units In)"
            onClick={() => onDirection('in')}
          />
          <DirectionPill
            active={direction === 'out'}
            tone="danger"
            icon={<ArrowUpRight size={13} />}
            label="Stock Out (Units Out)"
            onClick={() => onDirection('out')}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="rm-date">Date</Label>
          <Input id="rm-date" type="date" aria-invalid={Boolean(dateError)} {...registerDate} />
          {dateError && (
            <p role="alert" className="text-xs text-danger">
              {dateError}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rm-qty">{direction === 'in' ? 'Units In' : 'Units Out'}</Label>
          <Input
            id="rm-qty"
            type="number"
            inputMode="numeric"
            min={1}
            aria-invalid={Boolean(qtyError)}
            {...registerQty}
          />
          {qtyError && (
            <p role="alert" className="text-xs text-danger">
              {qtyError}
            </p>
          )}
          {insufficient && (
            <p role="alert" className="text-xs text-danger">
              Insufficient stock — only {item.qty} on hand.
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2.5 text-sm">
        <span className="text-text-3">New balance</span>
        <span className="flex items-center gap-2 font-mono">
          <span className="text-text-3">{formatNumber(item.qty)}</span>
          <span
            className={cn(
              'font-semibold',
              delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-text-3',
            )}
          >
            {delta > 0 ? '+' : ''}
            {delta}
          </span>
          <span aria-hidden className="text-text-3">
            →
          </span>
          <span className="text-base font-semibold text-text">{formatNumber(newBalance)}</span>
        </span>
      </div>
    </div>
  );
}

function DirectionPill({
  active,
  tone,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  tone: 'success' | 'danger';
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center justify-center gap-2 rounded-md border bg-bg-elev px-3 py-2.5 text-sm font-medium transition-colors',
        active
          ? tone === 'success'
            ? 'border-success bg-success-soft text-success ring-1 ring-success/30'
            : 'border-danger bg-danger-soft text-danger ring-1 ring-danger/30'
          : 'border-border-strong text-text-2 hover:bg-surface',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          tone === 'success' ? 'bg-success' : 'bg-danger',
        )}
      />
      <span aria-hidden>{icon}</span>
      {label}
    </button>
  );
}

function StepLogistics({
  register,
  errors,
}: {
  register: ReturnType<typeof useForm<Values>>['register'];
  errors: { location?: string; lot?: string; expires?: string; reason?: string };
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="rm-loc">Location</Label>
          <Input
            id="rm-loc"
            placeholder="e.g. FRZ-A-02"
            aria-invalid={Boolean(errors.location)}
            {...register('location')}
          />
          {errors.location && (
            <p role="alert" className="text-xs text-danger">
              {errors.location}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rm-lot">Lot number</Label>
          <Input
            id="rm-lot"
            placeholder="e.g. B-20261029"
            aria-invalid={Boolean(errors.lot)}
            {...register('lot')}
          />
          {errors.lot && (
            <p role="alert" className="text-xs text-danger">
              {errors.lot}
            </p>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rm-exp">Expiration date</Label>
        <Input id="rm-exp" type="date" {...register('expires')} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rm-reason">Reason</Label>
        <Input
          id="rm-reason"
          placeholder="Vendor receipt / Restock / Returned unused"
          aria-invalid={Boolean(errors.reason)}
          {...register('reason')}
        />
        {errors.reason && (
          <p role="alert" className="text-xs text-danger">
            {errors.reason}
          </p>
        )}
      </div>
    </div>
  );
}

function StepReview({
  item,
  values,
  intent,
  onIntent,
  error,
}: {
  item: InventoryItem;
  values: {
    direction: 'in' | 'out';
    qty: number;
    lot: string;
    expires?: string;
    location: string;
    reason: string;
  };
  intent: boolean;
  onIntent: (v: boolean) => void;
  error?: string;
}) {
  const rows: Array<[string, React.ReactNode]> = [
    ['Item:', item.desc],
    [
      'Direction:',
      <span
        key="dir"
        className={cn(
          'font-semibold',
          values.direction === 'in' ? 'text-success' : 'text-danger',
        )}
      >
        {values.direction === 'in' ? 'In' : 'Out'}
      </span>,
    ],
    ['Quantity:', <span key="q" className="font-mono">{values.qty}</span>],
    ['Lot #:', <span key="l" className="font-mono">{values.lot}</span>],
    ['Expiration:', <span key="e" className="font-mono">{values.expires || '—'}</span>],
    ['Location:', <span key="loc" className="font-mono">{values.location}</span>],
    ['Reason:', values.reason],
  ];

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-md border border-border bg-bg-elev">
        <div className="border-b border-border bg-surface px-4 py-2 text-sm font-semibold">
          Review Summary
        </div>
        <dl className="divide-y divide-dashed divide-border">
          {rows.map(([k, v]) => (
            <div
              key={k}
              className="grid grid-cols-[100px_1fr] items-baseline gap-3 px-4 py-2 text-sm"
            >
              <dt className="text-text-3">{k}</dt>
              <dd className="break-words text-text">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <label className="flex items-start gap-2.5 rounded-md border border-accent/30 bg-accent-soft/30 p-3 text-xs">
        <Checkbox
          checked={intent}
          onCheckedChange={(v) => onIntent(v === true)}
          className="mt-0.5"
        />
        <span className="leading-snug text-text-2">
          This action requires <strong className="text-text">electronic sign-off</strong>
        </span>
      </label>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function StepSignoff({
  registerUser,
  registerPw,
  username,
  reason,
  signatureData,
  onSignature,
  acknowledged,
  onAck,
  errors,
}: {
  registerUser: ReturnType<ReturnType<typeof useForm<Values>>['register']>;
  registerPw: ReturnType<ReturnType<typeof useForm<Values>>['register']>;
  username: string;
  reason: string;
  signatureData: string;
  onSignature: (d: string) => void;
  acknowledged: boolean;
  onAck: (v: boolean) => void;
  errors: {
    username?: string;
    password?: string;
    signatureData?: string;
    acknowledged?: string;
  };
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning-soft p-3 text-xs">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
        <div>
          <div className="font-semibold text-warning">Electronic Sign-off Required</div>
          <div className="mt-0.5 text-text-2">
            This is a regulated action. Confirm your identity to proceed.
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rm-user">Username</Label>
        <Input
          id="rm-user"
          autoComplete="username"
          aria-invalid={Boolean(errors.username)}
          {...registerUser}
        />
        {errors.username && (
          <p role="alert" className="text-xs text-danger">
            {errors.username}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rm-pw">Password</Label>
        <Input
          id="rm-pw"
          type="password"
          placeholder="Enter your password"
          autoComplete="current-password"
          aria-invalid={Boolean(errors.password)}
          {...registerPw}
        />
        {errors.password && (
          <p role="alert" className="text-xs text-danger">
            {errors.password}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rm-reason-readonly">Reason for Action</Label>
        <Input id="rm-reason-readonly" readOnly value={reason} />
      </div>

      <div className="space-y-1.5">
        <Label>Draw your signature</Label>
        <SignaturePad onChange={onSignature} />
        {errors.signatureData && (
          <p role="alert" className="text-xs text-danger">
            {errors.signatureData}
          </p>
        )}
      </div>

      <label className="flex items-start gap-2.5 rounded-md border border-border bg-bg-elev p-3 text-xs leading-snug text-text-2">
        <Checkbox
          checked={acknowledged}
          onCheckedChange={(v) => onAck(v === true)}
          className="mt-0.5"
        />
        <span>
          I acknowledge that this action will be recorded in the audit trail and is subject
          to regulatory review.
        </span>
      </label>
      {errors.acknowledged && (
        <p role="alert" className="text-xs text-danger">
          {errors.acknowledged}
        </p>
      )}
    </div>
  );
}
