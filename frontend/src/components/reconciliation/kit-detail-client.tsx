'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  FlaskConical,
  PackagePlus,
  PackageSearch,
  Pencil,
  Plus,
  ScrollText,
  Send,
  Undo2,
  Ban,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { usePermission } from '@/hooks/use-permission';
import type { ReauthResponse } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/client';
import {
  kitsApi,
  type ApiKit,
  type ApiKitActivityRow,
  type ApiKitAuditEvent,
  type ApiKitBatch,
  type ApiKitLine,
  type CancelLineInput,
  type KitStatus,
  type KitUpdateInput,
  type ReturnCellInput,
} from '@/lib/api/kits';
import { locationNodesApi, type LocationNode } from '@/lib/api/location-nodes';
import { lotsApi } from '@/lib/api/lots';
import { cn, formatMoney } from '@/lib/utils';
import { selectIsSuperAdmin, useAuthStore } from '@/stores/auth.store';

import { BoxCellPicker } from './cell-grid-picker';
import { LocationTreePicker } from './location-tree-picker';
import { LocationPath } from '@/components/locations/location-path';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  LotSourcePicker,
  autoFillFifo,
  picksToSources,
  picksTotal,
  picksValid,
  type LotPick,
} from './lot-source-picker';
import {
  ItemCell,
  KitStatusBadge,
  NumberInput,
  QtyCell,
  RuleNote,
  Stat,
  formatDateTime,
} from './recon-bits';
import { BatchDetailSheet } from './batch-detail-sheet';
import { KitCostExportButton } from './kit-cost-export-button';

const STEPS = [
  { key: 'issue', label: 'Issue', hint: 'Pull material to production' },
  { key: 'production', label: 'Production', hint: 'Adjust material on the floor' },
  { key: 'closeout', label: 'Close-Out', hint: 'Record output & reconcile' },
  { key: 'review', label: 'Review', hint: 'Confirm the batch, then produce or close' },
] as const;

/** URL segment per step — what the operator sees in the address bar and copies
 *  into a message. Kept apart from ``STEPS[].key`` so a label can be reworded
 *  without breaking a link somebody saved. */
const STEP_SLUGS = ['issue', 'production', 'close-out', 'review'] as const;

/** ``/reconciliation/<id>/close-out`` → 2. Anything unrecognised → ``null``, so
 *  the caller can fall back to the kit's own default rather than step 0. */
function stepFromSlug(slug: string | undefined): number | null {
  const i = STEP_SLUGS.indexOf(slug as (typeof STEP_SLUGS)[number]);
  return i === -1 ? null : i;
}

// Four steps (client 2026-07-22): Issue → Production (adjust only) → Close-Out
// (record output + reconcile) → Review & Close (summary + e-signed close). The
// signature lives on the final Review step; Production no longer gates advance.
function stepModel(status: KitStatus): { completed: number; reachable: number; def: number } {
  switch (status) {
    case 'draft':
      return { completed: 0, reachable: 0, def: 0 };
    case 'issued':
      return { completed: 1, reachable: 3, def: 1 };
    case 'in_production':
      return { completed: 1, reachable: 3, def: 1 };
    case 'closed':
      return { completed: 4, reachable: 3, def: 3 };
    case 'cancelled':
      return { completed: 0, reachable: 0, def: 0 };
    default:
      return { completed: 0, reachable: 0, def: 0 };
  }
}

const lineIssuedTotal = (l: ApiKitLine) => l.issued_qty + l.additional_issued_qty;

interface OutputDraft {
  good_qty: number | null;
  scrap_qty: number | null;
  output_location_node_id: string;
  /** Expiry of the produced lot — REQ-2026-07-01-INV-008. */
  output_expiration_date: string;
  /** Operator-entered lot number for this produced batch (client 2026-07-24 —
   *  replaces the old auto KIT-0289-N suffix). Required when good_qty >= 1. */
  output_lot_number: string;
}

/** One place a produced batch is stocked. A batch may be split across several
 *  (client 2026-07-23) when one LN2 box can't hold every unit — the rest go to
 *  another box, a freezer, or a shelf. A box row's quantity IS its picked
 *  ``cells``; a bulk row (shelf / freezer) carries a typed ``qty``. */
interface OutputDest {
  key: string;
  location_node_id: string;
  isBox: boolean;
  cells: string[];
  qty: number | null;
}

let _outputDestSeq = 0;
const emptyDest = (): OutputDest => ({
  key: `dest-${_outputDestSeq++}`,
  location_node_id: '',
  isBox: false,
  cells: [],
  qty: null,
});
/** Units this destination will place — cells for a box, the typed qty for bulk.
 *  A row with no location chosen places NOTHING, however its quantity reads:
 *  the quantity is pre-filled from the batch size before a location is picked
 *  (client 2026-07-28), and counting it would show "1 / 1 placed" while the
 *  output actually has nowhere to go. */
const destPlaced = (d: OutputDest): number =>
  d.location_node_id ? (d.isBox ? d.cells.length : d.qty ?? 0) : 0;

/** The BOM need for a line, rounded up to whole units (matches the backend). */
const lineNeededQty = (l: ApiKitLine) => Math.ceil(Number(l.needed_qty));

/** `"3:2"` → `{ grid_row: 3, grid_col: 2 }` — CellGridPicker's destination key. */
const toCell = (key: string): ReturnCellInput => {
  const [r, c] = key.split(':');
  return { grid_row: Number(r ?? 0), grid_col: Number(c ?? 0) };
};

/** Today as a local `yyyy-mm-dd` — the earliest a produced lot may expire. */
const todayStr = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function KitDetailClient({
  kitId,
  // The step segments render nothing — they exist so each step has a URL, and
  // the shell reads the segment to know which one to show (see the layout).
  // Accepted and ignored so Next's layout contract is honoured.
  children: _children,
}: {
  kitId: string;
  children?: React.ReactNode;
}) {
  const canSign = usePermission('inventory', 'sign');
  const canWrite = usePermission('inventory', 'create');
  // CTL-001 — every action that puts material BACK into inventory is
  // Super-Admin-only. `usePermission` can't answer this: `operator` holds both
  // `inventory:create` and `inventory:sign`, and the frontend collapses
  // `super_admin` into the same `admin` bucket, so the raw role is the only
  // thing that tells them apart (`selectIsSuperAdmin`). The API enforces it
  // too — this only hides controls that would come back a 403.
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);
  /** The cost export is Super-Admin-only too (client, 2026-09-03; it was Admin
   *  and above until then) — it carries what each customer is charged. Mirrors
   *  the endpoint's own RequireRole(SUPER_ADMIN_ROLE), and matches the RPT-001
   *  finance export. Same raw-role reasoning as `isSuperAdmin` above, so it is
   *  now the same value; kept as its own name because it answers a different
   *  question and the two could diverge again. */
  const canExportCosts = isSuperAdmin;
  /** The manual return (TRX-008) and the cancel that returns the whole floor. */
  const canReturn = canWrite && isSuperAdmin;
  /** The signed close, whose back-flush credits the leftover back to stock. */
  const canClose = canSign && isSuperAdmin;
  // Producing is deliberately NOT gated: it consumes floor material and mints
  // the output lot, so an operator keeps building without an admin present.

  const [kit, setKit] = React.useState<ApiKit | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [nodes, setNodes] = React.useState<LocationNode[]>([]);
  // ── The step is the URL ─────────────────────────────────────────────────
  // ``/reconciliation/<id>/close-out`` IS step 2 — there is no step state to
  // drift out of sync with the address bar, so a link, a refresh and the back
  // button all land exactly where they say they will.
  const router = useRouter();
  const pathname = usePathname();
  // Everything after the kit id: [] on the bare route, ['review','PL-123'] on a
  // lot deep link.
  const tail = React.useMemo(() => {
    const parts = pathname.split('/').filter(Boolean);
    const at = parts.indexOf(kitId);
    return at === -1 ? [] : parts.slice(at + 1);
  }, [pathname, kitId]);
  const urlStep = stepFromSlug(tail[0]);
  const stepHref = React.useCallback(
    (n: number) => `/reconciliation/${kitId}/${STEP_SLUGS[n] ?? STEP_SLUGS[0]}`,
    [kitId],
  );
  const activeStep = urlStep ?? 0;
  /** Navigate to a step. Deliberately keeps the ``useState`` setter signature —
   *  updater callbacks included — so every existing call site reads unchanged
   *  and none of them has to know the step now lives in the URL. */
  const setActiveStep = React.useCallback(
    (next: number | ((prev: number) => number)) => {
      const target = typeof next === 'function' ? next(urlStep ?? 0) : next;
      router.push(stepHref(target));
    },
    [router, stepHref, urlStep],
  );
  const [busy, setBusy] = React.useState(false);

  const [activityOpen, setActivityOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [reauthOpen, setReauthOpen] = React.useState(false);
  const [produceReauthOpen, setProduceReauthOpen] = React.useState(false);
  const [addingTo, setAddingTo] = React.useState<ApiKitLine | null>(null);
  const [returningFrom, setReturningFrom] = React.useState<ApiKitLine | null>(null);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  // Cancel is e-signed: the reauth dialog is the final confirmation. For a
  // post-issue kit the return locations are collected first (pendingCancelLines).
  const [cancelReauthOpen, setCancelReauthOpen] = React.useState(false);
  const [pendingCancelLines, setPendingCancelLines] = React.useState<CancelLineInput[]>([]);

  const [output, setOutput] = React.useState<OutputDraft>({
    good_qty: null,
    scrap_qty: 0,
    output_location_node_id: '',
    output_expiration_date: '',
    output_lot_number: '',
  });
  /** Operator-entered material used per component this batch (≥ recipe need). */
  const [used, setUsed] = React.useState<Record<string, number | null>>({});
  /** Where the produced OUTPUT is stocked — one or more destinations. A batch is
   *  split across several when one box can't hold every unit (client 2026-07-23);
   *  the common case is a single row. */
  const [outputDests, setOutputDests] = React.useState<OutputDest[]>([emptyDest()]);
  /** Per-line back-flush destinations. The leftover may be SPLIT across several
   *  locations when no single box has enough free cells (client 2026-07-30) — the
   *  same shape the produced output has used since 2026-07-23. */
  const [returnDests, setReturnDests] = React.useState<Record<string, OutputDest[]>>({});
  /** Per-line multi-lot issue picks — held locally, committed only on Issue. */
  const [linePicks, setLinePicks] = React.useState<Record<string, LotPick[]>>({});
  /** Live availability of the typed produced-batch lot number. ``unknown`` also
   *  covers a failed check — the server re-validates, so we never hard-block on
   *  a network hiccup. */
  const [lotStatus, setLotStatus] = React.useState<'unknown' | 'checking' | 'free' | 'taken'>(
    'unknown',
  );

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const k = await kitsApi.get(kitId, { signal });
        setKit(k);
        setOutput((prev) => ({
          // "This batch" holds only the NEXT batch's amount — never the kit's
          // cumulative totals. Both default to ZERO, not to what is owed
          // against the target: the operator is attesting to what they actually
          // made, and a pre-filled quantity is a number the form invented and
          // they then signed for. A blank form also means a freshly produced kit
          // comes back with nothing outstanding, instead of red text listing
          // what a batch nobody has started is missing.
          good_qty: prev.good_qty ?? 0,
          // ``k.scrap_qty`` is the kit's CUMULATIVE scrap across every batch;
          // reading it here put that running total into a per-batch field, so a
          // kit that had scrapped 4 units over its life opened its next batch
          // pre-scrapped by 4.
          scrap_qty: prev.scrap_qty ?? 0,
          output_location_node_id:
            k.output_location_node_id ?? prev.output_location_node_id ?? '',
          output_expiration_date: prev.output_expiration_date ?? '',
          output_lot_number: prev.output_lot_number ?? '',
        }));
        // Back-flush destinations are no longer seeded here — ``returnRowsFor``
        // defaults an unset line to the source it was pulled from, so there is
        // one place that rule lives.
        // Pre-fill each line's issue with a FIFO split covering the need
        // (KIT-002 "default the issue quantity to the needed amount").
        setLinePicks(
          Object.fromEntries(
            k.lines.map((l) => [l.id, autoFillFifo(l.source_lots, lineNeededQty(l))]),
          ),
        );
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load the kit.');
      } finally {
        setLoading(false);
      }
    },
    [kitId],
  );

  // Land the bare ``/reconciliation/<id>`` on the step the kit's status makes
  // sensible, and bounce a step the kit cannot reach yet — a draft kit has no
  // Close-Out to show, and a URL can be typed where a disabled tab could not be
  // clicked. ``replace``, so Back leaves the kit rather than bouncing again.
  React.useEffect(() => {
    if (!kit) return;
    const { def, reachable } = stepModel(kit.status);
    if (urlStep === null || urlStep > reachable) {
      router.replace(stepHref(urlStep === null ? def : Math.min(urlStep, reachable)));
    }
  }, [kit, urlStep, router, stepHref]);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    void locationNodesApi
      .storageTargets({ signal: ctrl.signal })
      .then(setNodes)
      .catch(() => setNodes([]));
    return () => ctrl.abort();
  }, [load]);

  // ``nodeOptions`` — ``{value: n.id, label: n.path ?? n.name}`` — used to be
  // built here and threaded into the steps so a chosen node could be shown as
  // text. That made a DROPDOWN's option label do double duty as display, which
  // is why those cells printed a full path. ``LocationPath`` resolves a node id
  // against the shared location forest instead, so nothing needs the list and
  // the pickers below build their own from ``nodes``.
  // Output + back-flush may land on a shelf, freezer sub-location, or an LN2 box
  // (KIT-005) — a box only alongside an explicit free-cell selection.
  const returnableIds = React.useMemo(
    () =>
      new Set(
        nodes
          .filter(
            (n) =>
              n.node_type === 'shelf' || n.node_type === 'sub_location' || n.node_type === 'box',
          )
          .map((n) => n.id),
      ),
    [nodes],
  );
  // The production location can be any node in the hierarchy (not just a
  // storage leaf), so resolve its name with a dedicated lookup.
  const [prodName, setProdName] = React.useState('');
  React.useEffect(() => {
    if (!kit) return;
    const ctrl = new AbortController();
    void locationNodesApi
      .get(kit.production_location_node_id, { signal: ctrl.signal })
      .then((n) => setProdName(n.name))
      .catch(() => setProdName(''));
    return () => ctrl.abort();
  }, [kit?.production_location_node_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<ApiKit>, ok: string, next?: number) => {
    setBusy(true);
    try {
      const k = await fn();
      setKit(k);
      if (next !== undefined) setActiveStep(next);
      else setActiveStep(stepModel(k.status).def);
      toast.success(ok);
    } catch (err) {
      toast.error('Action failed', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  // ── Close-out draft side-effects ────────────────────────────────────────
  // Declared BEFORE the loading/not-found early returns — hooks must run in the
  // same order on every render. They read ``output`` state, which exists from
  // the first render, so they don't need the loaded kit.
  const lotDraft = output.output_lot_number.trim();
  const makingOutput = (output.good_qty ?? 0) >= 1;

  // Lot numbers are globally unique, and a collision used to surface only after
  // the operator had reached Review and signed. Check it as they type so a taken
  // number blocks them on Close-Out instead (client 2026-07-28). The produce /
  // close-out call re-checks and stays the authority — a number free now can
  // still be claimed by someone else before this batch lands.
  React.useEffect(() => {
    if (!makingOutput || !lotDraft) {
      setLotStatus('unknown');
      return;
    }
    setLotStatus('checking');
    const ctrl = new AbortController();
    // Debounced so a typed lot number doesn't fire a request per keystroke.
    const timer = setTimeout(() => {
      lotsApi
        .numberAvailable(lotDraft, { signal: ctrl.signal })
        .then((r) => setLotStatus(r.available ? 'free' : 'taken'))
        .catch(() => {
          if (!ctrl.signal.aborted) setLotStatus('unknown');
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [lotDraft, makingOutput]);

  // A single destination has to take the whole batch, so keep its quantity on
  // "Quantity made (good)" automatically (client 2026-07-28). Deliberately NOT
  // applied to a box row (its quantity IS the picked cells) or once the operator
  // has SPLIT across several locations — that split is their decision to make.
  React.useEffect(() => {
    const good = output.good_qty ?? 0;
    setOutputDests((prev) => {
      const only = prev.length === 1 ? prev[0] : undefined;
      if (!only || only.isBox) return prev;
      const next = good > 0 ? good : null;
      return only.qty === next ? prev : [{ ...only, qty: next }];
    });
  }, [output.good_qty]);

  if (loading && !kit) {
    return (
      <>
        <PageHeader
          title="Loading kit…"
          crumbs={[{ label: 'Kitting', href: '/reconciliation' }]}
        />
        <div className="px-6 py-5 sm:px-8">
          <Card className="p-8 text-center text-sm text-text-3">Loading…</Card>
        </div>
      </>
    );
  }

  if (!kit) {
    return (
      <>
        <PageHeader
          title="Kit not found"
          crumbs={[{ label: 'Kitting', href: '/reconciliation' }]}
        />
        <div className="px-6 py-5 sm:px-8">
          <Card className="p-4">
            <EmptyState
              icon={PackageSearch}
              title={loadError ?? `No kit ${kitId}`}
              hint="It may have been removed."
              action={
                <Button asChild variant="primary">
                  <Link href="/reconciliation">Back to kits</Link>
                </Button>
              }
            />
          </Card>
        </div>
      </>
    );
  }

  const model = stepModel(kit.status);
  const editableDraft = kit.status === 'draft';
  const inProd = kit.status === 'issued' || kit.status === 'in_production';

  // ── Produce / Close readiness (KIT-007 incremental production) ───────────
  // The Close-Out form (good/scrap/output/used) feeds BOTH a "Produce" batch
  // (make units, keep the kit open) and the final "Close". Good accumulates on
  // the kit across produce batches, so a Close with good 0 is valid once earlier
  // batches produced something (it just back-flushes the remainder and locks).
  const producingNow = (output.good_qty ?? 0) >= 1;
  const priorGood = kit.good_qty ?? 0;
  const expiryValid = !output.output_expiration_date || output.output_expiration_date >= todayStr();
  // The good units must be fully placed — across ONE or MORE destinations
  // (client 2026-07-23) when a box can't hold them all. Every row needs a
  // location and a positive quantity (a box row's qty is its picked cells), and
  // the quantities must sum to the good count.
  const outputPlaced = outputDests.reduce((s, d) => s + destPlaced(d), 0);
  const outputRowsFilled = outputDests.every(
    (d) => Boolean(d.location_node_id) && destPlaced(d) > 0,
  );
  const outputComplete = (output.good_qty ?? 0) >= 1 && outputRowsFilled && outputPlaced === (output.good_qty ?? 0);
  // The operator ENTERS the material used per component (client 2026-07-23). It
  // must be at least the recipe need — ceil(qty_per_unit × (good+scrap)); you
  // can't make N units with less than N units' worth — and no more than what's
  // on the floor. Leftover (= floor − used) back-flushes at close.
  const batchAttempt = (output.good_qty ?? 0) + (output.scrap_qty ?? 0);
  // Mirrors the server: an ordinary kit scales the recipe by the batch, a
  // variable-yield kit takes one unit's worth however much it yields. A batch
  // producing nothing needs nothing, so a good=0 close still passes.
  const recipeUnits = batchAttempt === 0 ? 0 : kit.variable_yield ? 1 : batchAttempt;
  const lineNeed = (l: ApiKitLine) => Math.ceil(Number(l.qty_per_unit) * recipeUnits);
  const lineLeft = (l: ApiKitLine) => l.on_floor_qty - (used[l.id] ?? 0);
  // A media line's leftover is CONSUMED at sign-out, never handed back
  // (REQ-2026-07-31-KIT-003), so it needs no return destination — everywhere
  // else it is an ordinary line: same recipe need, same operator entry, same
  // gates. This is the only thing that differs.
  const backFlushes = (l: ApiKitLine) => !l.consumed_in_kit && lineLeft(l) > 0;
  const usedComplete = kit.lines.every((l) => used[l.id] !== null && used[l.id] !== undefined);
  // `lineNeed` already carries the variable-yield rule, so this gate stays on
  // for every kit — it is what stops a batch being produced from no material.
  const usedBelowNeed = kit.lines.some(
    (l) => used[l.id] != null && (used[l.id] as number) < lineNeed(l),
  );
  const usedOverFloor = kit.lines.some(
    (l) => used[l.id] != null && (used[l.id] as number) > l.on_floor_qty,
  );
  /** A line's back-flush rows, defaulted to one at its source.
   *
   *  A plain function, like ``lineLeft`` and ``isBox`` above — this component
   *  has an early return above here, so a hook would be called conditionally. */
  const returnRowsFor = (l: ApiKitLine): OutputDest[] =>
    returnDests[l.id] ?? [
      {
        ...emptyDest(),
        key: `ret-${l.id}`,
        location_node_id: l.return_location_node_id ?? l.source_location_node_id ?? '',
        qty: lineLeft(l),
      },
    ];
  /** Units of a line's leftover already placed across its destinations. */
  const returnPlaced = (l: ApiKitLine) =>
    returnRowsFor(l).reduce((s, d) => s + destPlaced(d), 0);
  /** First destination per line, for the Review step's "Back-flushes to" column.
   *  Derived rather than held: the destinations are now the source of truth, and
   *  a second copy would drift the moment a split is edited. */
  const returnLoc: Record<string, string> = Object.fromEntries(
    kit.lines.map((l) => [l.id, returnRowsFor(l)[0]?.location_node_id ?? '']),
  );
  // Every leftover unit must have somewhere to go — across ALL of a line's
  // destinations, since the leftover may be split between boxes.
  const cellsIncomplete = kit.lines.some((l) => {
    if (!backFlushes(l)) return false;
    return returnPlaced(l) !== lineLeft(l);
  });
  const usedValid = usedComplete && !usedBelowNeed && !usedOverFloor;
  // The operator types the produced batch's lot number (client 2026-07-24 —
  // replaces the old auto KIT-0289-N suffix). Required only when this batch makes
  // output; a good-0 close mints no lot, so it's not needed then.
  // Lot numbers are globally unique, and the collision used to surface only when
  // the operator had already reached Review and signed. Check it as they type so
  // a taken number blocks them HERE, on Close-Out (client 2026-07-28). The
  // produce / close-out call re-checks and stays the authority — a number free
  // now can still be claimed by someone else before this batch lands.
  const lotEntered = output.output_lot_number.trim();
  const lotNumberValid =
    !producingNow || (Boolean(lotEntered) && lotStatus !== 'taken' && lotStatus !== 'checking');
  // Produce a batch NOW (keep open): make ≥ 1, with output + valid used. No
  // back-flush, so no return-cell check.
  const produceReady =
    producingNow &&
    output.scrap_qty !== null &&
    expiryValid &&
    outputComplete &&
    lotNumberValid &&
    usedValid;
  // Close (finalize): cumulative good (prior + this batch) ≥ 1. Output required
  // only if producing a final batch; a good-0 close just back-flushes the rest.
  const closeReady =
    priorGood + (output.good_qty ?? 0) >= 1 &&
    output.scrap_qty !== null &&
    expiryValid &&
    (producingNow ? outputComplete : true) &&
    lotNumberValid &&
    usedValid &&
    !cellsIncomplete;
  // Why the Produce / Close button is disabled, in the order the operator reads
  // the form. A silently greyed-out button is unreadable — every gate above must
  // be able to say what it wants (client 2026-07-28). Same conditions as
  // ``produceReady`` / ``closeReady``, so the list is empty exactly when the
  // button is live.
  const finalizeOnly = !producingNow;
  // Has the operator begun entering THIS batch at all? Straight after a produce
  // the form is deliberately blank, and a blank form is not a wrong one — the
  // count of what it is "missing" then reads as an accusation about work nobody
  // has started. The reasons still reach anyone who wants them: each field
  // prints its own message once touched, and the disabled button keeps the full
  // list as its tooltip.
  const batchStarted =
    (output.good_qty ?? 0) > 0 ||
    (output.scrap_qty ?? 0) > 0 ||
    lotEntered.length > 0 ||
    outputDests.some((d) => Boolean(d.location_node_id)) ||
    Object.values(used).some((v) => v != null);
  const blockers: string[] = [];
  if (finalizeOnly && priorGood + (output.good_qty ?? 0) < 1) {
    blockers.push('Nothing produced yet — make at least one unit before closing.');
  }
  if (output.scrap_qty === null) blockers.push('Enter the scrapped quantity (0 if none).');
  if (!expiryValid) blockers.push('The expiry date can’t be in the past.');
  if (producingNow) {
    if (!lotEntered) {
      blockers.push('Enter the produced lot number.');
    } else if (lotStatus === 'taken') {
      blockers.push(`Lot number “${lotEntered}” is already used — choose another.`);
    } else if (lotStatus === 'checking') {
      blockers.push('Checking the lot number…');
    }
    if (!outputComplete) {
      const missingLoc = outputDests.some((d) => !d.location_node_id);
      const short = (output.good_qty ?? 0) - outputPlaced;
      if (missingLoc) {
        blockers.push('Choose where to stock the output.');
      } else if (short > 0) {
        blockers.push(`Place all ${output.good_qty} units — ${short} still to place.`);
      } else if (short < 0) {
        blockers.push(`Placed ${outputPlaced} but only ${output.good_qty} were made.`);
      }
    }
  }
  if (!usedComplete) {
    blockers.push('Enter how much of each component this batch used.');
  } else {
    const below = kit.lines.filter(
      (l) => used[l.id] != null && (used[l.id] as number) < lineNeed(l),
    );
    const over = kit.lines.filter(
      (l) => used[l.id] != null && (used[l.id] as number) > l.on_floor_qty,
    );
    if (below.length > 0) {
      blockers.push(
        `Used is below the recipe need for ${below.map((l) => l.item_number).join(', ')}.`,
      );
    }
    if (over.length > 0) {
      blockers.push(
        `Used is more than what’s on the floor for ${over.map((l) => l.item_number).join(', ')}.`,
      );
    }
  }
  // Back-flush cells gate the CLOSE only — a produce batch back-flushes nothing,
  // so "Produce" can be live while this is outstanding. The list is only rendered
  // when the button is actually disabled, so it never contradicts the button.
  if (cellsIncomplete) {
    blockers.push('Pick a back-flush cell for every leftover unit before closing.');
  }

  // The reasons show only while a button on this step is actually disabled — on
  // Close-Out (step 2) and Review (step 3), where these gates apply. Step 2 has
  // one button, so its own gate governs. Step 3 shows Produce AND Sign & close
  // together, so either being blocked is worth explaining; the close-only
  // reasons say "before closing" so they never read as blocking Produce.
  //
  // CTL-001: when the viewer cannot close, the close-only gates are not
  // blocking anything they could do — counting them would print "3 things to
  // fix above" next to a screen with no close button on it.
  const kitOpen = kit.status === 'issued' || kit.status === 'in_production';
  const stepBlocked = finalizeOnly
    ? canClose && !closeReady
    : activeStep === 3
      ? !produceReady || (canClose && !closeReady)
      : !produceReady;
  const primaryBlocked = kitOpen && (activeStep === 2 || activeStep === 3) && stepBlocked;

  // No recipe gating at issue (KIT-007): a short or even empty issue is allowed
  // — issue for a campaign up front, or assign at point of use and top up later.
  // The ONLY block is physical: a pick can't pull more of a lot than exists.
  const issueBlocked =
    editableDraft &&
    kit.lines.some((l) => !picksValid(l.source_lots, linePicks[l.id] ?? []));

  const onIssue = () =>
    void run(
      () =>
        kitsApi.issue(kit.id, {
          lines: kit.lines.map((l) => ({
            line_id: l.id,
            sources: picksToSources(linePicks[l.id] ?? []),
          })),
        }),
      'Material issued',
      1,
    );

  // Entering close-out: pre-fill each line's Used with the recipe need (the
  // minimum) and default the back-flush location to the source. Both editable.
  const enterCloseOut = () => {
    if (kit.status === 'issued' || kit.status === 'in_production') {
      const attempted = (output.good_qty ?? kit.target_qty) + (output.scrap_qty ?? 0);
      // Nothing being made consumes nothing. A variable-yield kit otherwise
      // pre-fills one run's worth, not the target's: seeding it off a planned
      // quantity would put a number on the form that the recipe never claimed
      // and the reactor never took.
      const units = attempted === 0 ? 0 : kit.variable_yield ? 1 : attempted;
      setUsed((prev) => {
        const next = { ...prev };
        for (const l of kit.lines) {
          if (next[l.id] == null) {
            next[l.id] = Math.ceil(Number(l.qty_per_unit) * units);
          }
        }
        return next;
      });
      // Back-flush destinations default themselves — see ``returnRowsFor``.
    }
    setActiveStep(2);
  };
  const onProductionNext = enterCloseOut;

  // The produced units, mapped to the API's multi-destination `outputs` (one
  // entry per filled row; a box row sends its cells, a bulk row its qty).
  const buildOutputs = () =>
    outputDests
      .filter((d) => d.location_node_id && destPlaced(d) > 0)
      .map((d) => ({
        location_node_id: d.location_node_id,
        qty: destPlaced(d),
        cells: d.isBox ? d.cells.map(toCell) : [],
      }));

  const onCloseConfirmed = async (evidence: ReauthResponse) => {
    try {
      const k = await kitsApi.closeOut(kit.id, {
        good_qty: output.good_qty ?? 0,
        scrap_qty: output.scrap_qty ?? 0,
        outputs: (output.good_qty ?? 0) >= 1 ? buildOutputs() : [],
        output_expiration_date: output.output_expiration_date || null,
        output_lot_number: output.output_lot_number?.trim() || undefined,
        lines: kit.lines.map((l) => ({
          line_id: l.id,
          // For a media line the close-out overrides this with the whole floor
          // (KIT-003); for every other line it is what the operator entered.
          used_qty: used[l.id] ?? 0,
          // Only lines with something left carry destinations; the rest have
          // nothing to place, and an empty list means "use the default".
          destinations: backFlushes(l)
            ? returnRowsFor(l)
                  .filter((d) => d.location_node_id && destPlaced(d) > 0)
                  .map((d) => ({
                    location_node_id: d.location_node_id,
                    qty: destPlaced(d),
                    return_cells: d.isBox ? d.cells.map(toCell) : undefined,
                  }))
              : [],
        })),
        evidence_id: evidence.evidence_id,
        reason: evidence.comment ?? '',
      });
      setKit(k);
      setActiveStep(3);
      toast.success(`${k.kit_number} closed`, {
        description: `${k.good_qty} × ${k.item_number} stocked; leftovers back-flushed.`,
      });
    } catch (err) {
      toast.error('Close-out failed', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  };

  // Produce a batch and KEEP the kit open (KIT-007). The operator's Used per
  // component is validated server-side (≥ need, ≤ floor). Does NOT back-flush or
  // lock. Afterwards the form resets for the next batch and we land on Review.
  const onProduceConfirmed = async (evidence: ReauthResponse) => {
    try {
      const k = await kitsApi.produce(kit.id, {
        good_qty: output.good_qty!,
        scrap_qty: output.scrap_qty ?? 0,
        outputs: buildOutputs(),
        output_expiration_date: output.output_expiration_date || null,
        output_lot_number: output.output_lot_number?.trim() || undefined,
        lines: kit.lines.map((l) => ({ line_id: l.id, used_qty: used[l.id] as number })),
        evidence_id: evidence.evidence_id,
        reason: evidence.comment ?? '',
      });
      const made = output.good_qty ?? 0;
      setKit(k);
      // Reset the batch form for the next batch.
      setOutput((p) => ({
        // Back to zero, not to what is still owed against the target. The batch
        // just made is folded into ``k.good_qty``; leaving a quantity in the
        // form implies another batch is already under way, and every field it
        // depends on — lot number, output location — is now blank, so the
        // screen filled with red text for a batch the operator had not begun.
        // Zero means "no batch in progress", which is the truth after a produce.
        good_qty: 0,
        scrap_qty: 0,
        output_location_node_id: p.output_location_node_id,
        output_expiration_date: '',
        output_lot_number: '',
      }));
      setOutputDests([emptyDest()]);
      setUsed(Object.fromEntries(k.lines.map((l) => [l.id, null])));
      setActiveStep(3);
      toast.success(`Produced ${made} × ${k.item_number}`, {
        description: `${k.good_qty} made so far — the kit is still open.`,
      });
    } catch (err) {
      toast.error('Could not produce', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  };

  const onCancel = () => {
    // Cancelling is e-signed. A draft has moved nothing, so the signature IS the
    // confirmation. Post-issue, material must go somewhere specific — collect the
    // per-line return locations first (D1), then sign.
    if (editableDraft) {
      setPendingCancelLines([]);
      setCancelReauthOpen(true);
    } else {
      setCancelOpen(true);
    }
  };

  const onCancelConfirmed = async (evidence: ReauthResponse) => {
    try {
      const k = await kitsApi.cancel(kit.id, {
        evidence_id: evidence.evidence_id,
        reason: evidence.comment || undefined,
        lines: pendingCancelLines,
      });
      setKit(k);
      setActiveStep(stepModel(k.status).def);
      toast.success(`${k.kit_number} cancelled`);
    } catch (err) {
      toast.error('Could not cancel', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Kitting', href: '/reconciliation' }, { label: kit.kit_number }]}
        title={kit.kit_number}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <KitStatusBadge status={kit.status} />
            <span>
              Building <span className="font-mono text-text">{kit.target_qty}</span> ×{' '}
              {/* The built item links to its Unit Ledger, matching ItemCell. */}
              <Link
                href={`/inventory/${kit.item_id}/ledger`}
                className="rounded-sm font-mono text-text hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {kit.item_number}
              </Link>{' '}
              — {kit.description}
            </span>
            <span className="text-text-3">· at {prodName || '…'}</span>
          </span>
        }
        actions={
          <>
            {canWrite && kit.status !== 'closed' && kit.status !== 'cancelled' && (
              <Button variant="secondary" onClick={() => setEditOpen(true)} disabled={busy}>
                <Pencil size={14} /> Edit
              </Button>
            )}
            <Button variant="secondary" onClick={() => setActivityOpen(true)}>
              <ScrollText size={14} /> Activity log
            </Button>
            {/* Scoped to THIS kit, the way the inventory Export button exports
                the tier you are looking at (RPT-003). Only once the kit has
                produced something — an export of a kit with no finished lot is
                a header row. Admin+, matching the endpoint's own gate. */}
            {canExportCosts && kit.batches.length > 0 && (
              <KitCostExportButton
                kitId={kit.id}
                kitNumber={kit.kit_number}
                label="Export cost"
              />
            )}
            {/* CTL-001: cancelling an issued kit hands the whole floor back to
                inventory, so it is Super-Admin-only. A draft cancel moves
                nothing, but it is hidden on the same rule — one visible
                "Cancel kit" that sometimes works would read as a bug. */}
            {(editableDraft || inProd) && canReturn && (
              <Button variant="danger" onClick={() => void onCancel()} disabled={busy}>
                Cancel kit
              </Button>
            )}
          </>
        }
      />

      <div className="px-6 py-5 sm:px-8">
        {/* Stepper */}
        <Card className="mb-5 p-2 sm:p-3">
          {/* Four steps, each a 32px disc plus an unwrappable label, come to
              roughly 540px before padding. Below that the row used to push the
              whole PAGE sideways — the body scrolled, so the header and every
              panel below slid out of view together. It scrolls inside its own
              card now, and the connectors collapse so it rarely needs to. */}
          <nav aria-label="Kit progress" className="scroll-strip">
            <ol className="flex min-w-max items-stretch sm:min-w-0">
              {STEPS.map((step, i) => {
                const isCurrent = i === activeStep;
                const isDone = i < model.completed;
                const isReachable = i <= model.reachable;
                // Production no longer gates advance (client 2026-07-22, KIT-007).
                // The only forward gate is Review: you can't jump to the signed
                // close until the output + reconciliation are complete.
                const gateBlocked = i === 3 && i > activeStep && !closeReady;
                const clickable = isReachable && !gateBlocked;
                return (
                  <li key={step.key} className="flex flex-1 items-center last:flex-none">
                    <button
                      type="button"
                      disabled={!clickable}
                      onClick={() => clickable && (i === 2 ? enterCloseOut() : setActiveStep(i))}
                      aria-current={isCurrent ? 'step' : undefined}
                      title={
                        gateBlocked
                          ? 'Enter the output and used quantities on Close-Out first'
                          : undefined
                      }
                      className={cn(
                        'group flex items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:px-3',
                        clickable ? 'hover:bg-surface' : 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-colors',
                          isCurrent && 'border-accent bg-accent text-white',
                          isDone && !isCurrent && 'border-success bg-success text-white',
                          !isCurrent && !isDone && 'border-border-strong bg-bg-elev text-text-3',
                        )}
                      >
                        {isDone && !isCurrent ? <Check size={16} /> : i + 1}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={cn(
                            'block text-sm font-medium',
                            isCurrent || isDone ? 'text-text' : 'text-text-3',
                          )}
                        >
                          {step.label}
                        </span>
                        <span className="hidden text-xs text-text-3 sm:block">{step.hint}</span>
                      </span>
                    </button>
                    {i < STEPS.length - 1 && (
                      <span
                        className={cn(
                          // Below sm the row is already at its natural width,
                          // so the connector takes a fixed sliver instead of
                          // demanding flex space the viewport hasn't got.
                          'mx-1 h-px w-4 shrink-0 sm:mx-2 sm:w-auto sm:flex-1',
                          i < model.completed ? 'bg-success' : 'bg-border',
                        )}
                        aria-hidden
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        </Card>

        {activeStep === 0 && (
          <IssueStep
            kit={kit}
            editableDraft={editableDraft}
            busy={busy}
            picks={linePicks}
            onPicksChange={(lineId, picks) =>
              setLinePicks((prev) => ({ ...prev, [lineId]: picks }))
            }
          />
        )}
        {activeStep === 1 && (
          <ProductionStep
            kit={kit}
            canWrite={canWrite}
            canReturn={canReturn}
            busy={busy}
            onIssueMore={(l) => setAddingTo(l)}
            onReturn={(l) => setReturningFrom(l)}
          />
        )}
        {activeStep === 2 && (
          <CloseOutStep
            kit={kit}
            output={output}
            onOutputChange={setOutput}
            outputAllowedIds={returnableIds}
            outputDests={outputDests}
            onOutputDests={(next) => {
              setOutputDests(next);
              // Keep the draft's primary location in sync for the Review summary.
              setOutput((o) => ({
                ...o,
                output_location_node_id: next[0]?.location_node_id ?? '',
              }));
            }}
            used={used}
            onUsed={(id, v) => setUsed((u) => ({ ...u, [id]: v }))}
            lotStatus={lotStatus}
            returnRowsFor={returnRowsFor}
            onReturnDests={(id, next) => setReturnDests((p) => ({ ...p, [id]: next }))}
            returnPlaced={returnPlaced}
            returnAllowedIds={returnableIds}
          />
        )}
        {activeStep === 3 && (
          <ReviewStep
            kit={kit}
            output={output}
            outputDests={outputDests}
            used={used}
            returnLoc={returnLoc}
            prodName={prodName}
            canClose={canClose}
          />
        )}

        {/* Step footer — advance action always here. Wraps: "Back" plus
            "Produce another batch" plus "Sign & close kit" is wider than a
            phone, and a row that refuses to wrap takes the whole page sideways
            with it rather than stacking. */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <Button
            variant="ghost"
            disabled={activeStep === 0}
            onClick={() => setActiveStep((s) => Math.max(0, s - 1))}
          >
            <ChevronLeft size={14} /> Back
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {/* Why the primary action is disabled — a COUNT only. Each of these
                already prints in red under its own field, so listing them here
                too was pure duplication; this just points at them. The full list
                is the button's tooltip. Rendered only when the button really is
                disabled, so it can never contradict a live button. */}
            {primaryBlocked && blockers.length > 0 && batchStarted && (
              <span className="text-xs text-danger">
                {blockers.length} thing{blockers.length === 1 ? '' : 's'} to fix above
              </span>
            )}
            {footerPrimary(kit, activeStep, model, {
              blockers: primaryBlocked ? blockers : [],
              canWrite,
              canSign,
              canClose,
              busy,
              closeReady,
              produceReady,
              producingNow,
              issueBlocked,
              onIssue,
              onNext: () => setActiveStep((s) => Math.min(model.reachable, s + 1)),
              onProductionNext,
              onCloseOutNext: () => setActiveStep(3),
              onProduce: () => setProduceReauthOpen(true),
              onProduceAnother: enterCloseOut,
              onClose: () => setReauthOpen(true),
            })}
          </div>
        </div>
      </div>

      <AdditionalIssueDialog
        kit={kit}
        line={addingTo}
        onOpenChange={(o) => !o && setAddingTo(null)}
        onDone={(k) => {
          setKit(k);
          setAddingTo(null);
        }}
      />

      <CancelKitDialog
        kit={kit}
        open={cancelOpen}
        returnAllowedIds={returnableIds}
        onOpenChange={setCancelOpen}
        onSubmit={(cancelLines) => {
          setCancelOpen(false);
          setPendingCancelLines(cancelLines);
          setCancelReauthOpen(true);
        }}
      />

      <ReturnExcessDialog
        kit={kit}
        line={returningFrom}
        returnAllowedIds={returnableIds}
        onOpenChange={(o) => !o && setReturningFrom(null)}
        onDone={(k) => {
          setKit(k);
          setReturningFrom(null);
        }}
      />

      <PasswordReauthDialog
        open={reauthOpen}
        onOpenChange={setReauthOpen}
        action="kit.closeout"
        recordTable="app.kits"
        recordId={kit.id}
        meaning={`I am closing kit ${kit.kit_number}: ${output.good_qty ?? 0} good this batch, and back-flushing the leftover.`}
        title="Sign this close-out"
        submitLabel="Close kit"
        commentPlaceholder="e.g. Batch record 2026-07-20"
        onConfirmed={onCloseConfirmed}
      />

      <PasswordReauthDialog
        open={produceReauthOpen}
        onOpenChange={setProduceReauthOpen}
        action="kit.produce"
        recordTable="app.kits"
        recordId={kit.id}
        meaning={`I am producing ${output.good_qty ?? 0} × ${kit.item_number} for kit ${kit.kit_number}. The kit stays open to produce more.`}
        title="Sign this batch"
        submitLabel="Produce batch"
        commentPlaceholder="e.g. Batch record 2026-07-23"
        onConfirmed={onProduceConfirmed}
      />

      <PasswordReauthDialog
        open={cancelReauthOpen}
        onOpenChange={setCancelReauthOpen}
        action="kit.cancel"
        recordTable="app.kits"
        recordId={kit.id}
        meaning={
          editableDraft
            ? `I am cancelling draft kit ${kit.kit_number}. No material has moved.`
            : // What the signature actually attests to. Media is NOT returned on
              // a cancel — it is discarded (KIT-003) — so a blanket "returning
              // all material" would be a false statement under e-signature.
              kit.lines.some((l) => l.consumed_in_kit && l.on_floor_qty > 0)
              ? `I am cancelling kit ${kit.kit_number}, returning the material still on the floor to inventory and discarding the media, which is never returned.`
              : `I am cancelling kit ${kit.kit_number} and returning all material still on the floor to inventory.`
        }
        title="Sign this cancellation"
        submitLabel="Cancel kit"
        commentPlaceholder="e.g. Batch aborted — contamination"
        onConfirmed={onCancelConfirmed}
      />

      <ActivitySheet kitId={kit.id} kitNumber={kit.kit_number} open={activityOpen} onOpenChange={setActivityOpen} />
      <EditKitDialog kit={kit} open={editOpen} onOpenChange={setEditOpen} onDone={(k) => setKit(k)} />
    </>
  );
}

// ── Edit kit (name / target) ────────────────────────────────────────────────

function EditKitDialog({
  kit,
  open,
  onOpenChange,
  onDone,
}: {
  kit: ApiKit;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (kit: ApiKit) => void;
}) {
  const draft = kit.status === 'draft';
  const [name, setName] = React.useState(kit.kit_number);
  const [target, setTarget] = React.useState<number | null>(kit.target_qty);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(kit.kit_number);
      setTarget(kit.target_qty);
    }
  }, [open, kit.kit_number, kit.target_qty]);

  const nameChanged = name.trim() !== kit.kit_number;
  const targetChanged = draft && target !== null && target !== kit.target_qty;
  const ready =
    name.trim().length > 0 && (!draft || (target !== null && target > 0)) && (nameChanged || targetChanged);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const input: KitUpdateInput = {};
      if (nameChanged) input.kit_number = name.trim();
      if (targetChanged) input.target_qty = target as number;
      const k = await kitsApi.update(kit.id, input);
      toast.success('Kit updated');
      onDone(k);
      onOpenChange(false);
    } catch (err) {
      toast.error('Could not update the kit', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {kit.kit_number}</DialogTitle>
          <DialogDescription>
            Rename the kit{draft ? ' or change how many to build' : ''}.
            {draft ? '' : ' The target is locked once the kit is issued.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">Kit name</label>
            <Input aria-label="Kit name" value={name} onChange={(e) => setName(e.target.value)} />
            <p className="mt-1 text-[11px] text-text-3">Also names the produced lot. Must be unique.</p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">
              Target quantity{' '}
              {!draft && <span className="font-normal text-text-3">(locked after issue)</span>}
            </label>
            <NumberInput
              aria-label="Target quantity"
              value={target}
              min={1}
              disabled={!draft}
              onChange={setTarget}
            />
            {targetChanged && (
              <p className="mt-1 text-[11px] text-text-3">
                Changing the target resets each line’s suggested issue quantity.
              </p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !ready}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function footerPrimary(
  kit: ApiKit,
  activeStep: number,
  model: { reachable: number },
  ctx: {
    canWrite: boolean;
    canSign: boolean;
    /** CTL-001 — ``canSign`` AND a real Super Admin. Gates the terminal close
     *  only; ``canSign`` alone still governs Produce. */
    canClose: boolean;
    busy: boolean;
    closeReady: boolean;
    produceReady: boolean;
    producingNow: boolean;
    issueBlocked: boolean;
    /** Outstanding reasons, shown as the disabled button's tooltip. Empty when
     *  the button is live. */
    blockers: string[];
    onIssue: () => void;
    onNext: () => void;
    onProductionNext: () => void;
    onCloseOutNext: () => void;
    onProduce: () => void;
    onProduceAnother: () => void;
    onClose: () => void;
  },
) {
  const open = kit.status === 'issued' || kit.status === 'in_production';
  // The outstanding reasons, one per line, as the disabled button's tooltip —
  // the detail lives under each field, so the footer only summarises.
  const blockerTitle = ctx.blockers.length > 0 ? ctx.blockers.join('\n') : undefined;
  const nextBtn = (onClick: () => void, disabled = false, title?: string) => (
    <Button variant="primary" onClick={onClick} disabled={ctx.busy || disabled} title={title}>
      Next: {STEPS[activeStep + 1]?.label} <ArrowRight size={14} />
    </Button>
  );
  // Step 0 — Issue.
  if (activeStep === 0) {
    if (kit.status === 'draft')
      return ctx.canWrite ? (
        <Button
          variant="primary"
          onClick={ctx.onIssue}
          disabled={ctx.busy || ctx.issueBlocked}
          title={ctx.issueBlocked ? 'A component pulls more than that lot holds' : undefined}
        >
          Issue material <ArrowRight size={14} />
        </Button>
      ) : (
        <span />
      );
    return model.reachable > 0 ? nextBtn(ctx.onNext) : <span />;
  }
  // Step 1 — Production (adjust only, no gate).
  if (activeStep === 1) return model.reachable > 1 ? nextBtn(ctx.onProductionNext) : <span />;
  // Step 2 — Close-Out: go to Review to confirm the batch, then produce/close
  // there. The button reads "Produce" when a batch is entered (it leads to the
  // Review-and-produce screen), or "Review & close" for a pure finalize.
  if (activeStep === 2 && open) {
    const finalize = !ctx.producingNow;
    // CTL-001: for a viewer who cannot close, this button is pure navigation to
    // a read-only Review — gating it on ``closeReady`` would strand them on
    // Close-Out behind conditions only a Super Admin can act on.
    const canAdvance = finalize ? !ctx.canClose || ctx.closeReady : ctx.produceReady;
    return (
      <Button
        variant="primary"
        onClick={ctx.onCloseOutNext}
        disabled={ctx.busy || !canAdvance}
        title={canAdvance ? undefined : blockerTitle}
      >
        {finalize ? (
          <>
            {/* CTL-001: a non-Super-Admin can still read the Review step, so
                the step stays reachable — the button just stops promising a
                close it cannot perform. */}
            {ctx.canClose ? 'Review & close' : 'Review'} <ArrowRight size={14} />
          </>
        ) : (
          <>
            <FlaskConical size={14} /> Produce <ArrowRight size={14} />
          </>
        )}
      </Button>
    );
  }
  // Step 3 — Review: produce THIS batch (keep open) or the signed terminal close.
  if (activeStep === 3 && open)
    return (
      <div className="flex items-center gap-2">
        {ctx.producingNow ? (
          ctx.canSign && (
            <Button
              variant="primary"
              onClick={ctx.onProduce}
              disabled={ctx.busy || !ctx.produceReady}
              title={
                ctx.produceReady ? 'Make this batch and keep the kit open' : blockerTitle
              }
            >
              <FlaskConical size={14} /> Produce this batch
            </Button>
          )
        ) : (
          <Button variant="ghost" onClick={ctx.onProduceAnother} disabled={ctx.busy}>
            Produce another batch
          </Button>
        )}
        {/* CTL-001 — the close back-flushes every leftover unit to inventory,
            so it needs a Super Admin. Hidden, not disabled: the two live
            buttons beside it (Produce / Produce another batch) are the whole
            job an operator still has here, and a permanently dead primary
            would out-rank them. */}
        {ctx.canClose ? (
          <Button
            variant={ctx.producingNow ? 'secondary' : 'primary'}
            onClick={ctx.onClose}
            disabled={!ctx.closeReady || ctx.busy}
            title={ctx.closeReady ? undefined : blockerTitle}
          >
            Sign &amp; close kit <ArrowRight size={14} />
          </Button>
        ) : (
          <span className="text-xs text-text-3">
            A Super Admin signs the close-out.
          </span>
        )}
      </div>
    );
  return <span />;
}

// ── Issue step ────────────────────────────────────────────────────────────

function IssueStep({
  kit,
  editableDraft,
  busy,
  picks,
  onPicksChange,
}: {
  kit: ApiKit;
  editableDraft: boolean;
  busy: boolean;
  picks: Record<string, LotPick[]>;
  onPicksChange: (lineId: string, picks: LotPick[]) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Components" value={kit.lines.length} hint="BOM lines" />
        <Stat
          label="Needed"
          value={kit.lines.reduce((a, l) => a + Number(l.needed_qty), 0)}
          hint={`To build ${kit.target_qty}`}
        />
        <Stat label="Status" value={editableDraft ? 'Draft' : 'Issued'} hint={editableDraft ? 'Nothing moved yet' : 'Stock decremented'} />
      </div>

      {editableDraft ? (
        <div className="space-y-3">
          <p className="text-xs text-text-3">
            Pull each component up to its Needed amount. You can draw from several lots/shelves at
            once — <span className="text-text-2">Auto-fill FIFO</span> takes the earliest-expiry lots
            first, or set the quantities by hand. For an LN2 box, tap the exact vials. Then press{' '}
            <span className="text-text-2">Issue material</span> to commit.
          </p>
          {kit.lines.map((line) => {
            const needed = lineNeededQty(line);
            const linePickList = picks[line.id] ?? [];
            return (
              <Card key={line.id} className="p-4">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <ItemCell
                    itemNumber={line.item_number}
                    description={line.description}
                    itemId={line.item_id}
                  />
                  <div className="flex items-center gap-4 text-xs">
                    <span className="text-text-3">
                      Needed <span className="font-mono text-text">{needed}</span>
                    </span>
                    <span className={cn('text-text-3', line.on_hand <= 0 && 'text-danger')}>
                      On hand <span className="font-mono text-text">{line.on_hand}</span>
                    </span>
                  </div>
                </div>
                <LotSourcePicker
                  itemNumber={line.item_number}
                  lots={line.source_lots}
                  needed={needed}
                  picks={linePickList}
                  onChange={(p) => onPicksChange(line.id, p)}
                  disabled={busy}
                />
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="p-4">
          <div className="mb-3">
            <h2 className="text-sm font-medium text-text">Issued to production</h2>
            <p className="mt-0.5 text-xs text-text-3">
              A snapshot of what was pulled at issue. Adjustments (issue more / return) and the
              produced output are handled on the next steps.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Needed</th>
                  <th className="px-3 py-2 text-right font-medium">Issued</th>
                  <th className="px-3 py-2 font-medium">Pulled from</th>
                </tr>
              </thead>
              <tbody>
                {kit.lines.map((line) => (
                  <tr key={line.id} className="border-b border-border/60 align-top">
                    <td className="max-w-[280px] px-3 py-2.5">
                      <ItemCell
                        itemNumber={line.item_number}
                        description={line.description}
                        itemId={line.item_id}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <QtyCell value={Number(line.needed_qty)} title={`×${line.qty_per_unit} per unit`} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <QtyCell value={line.issued_qty} />
                    </td>
                    <td className="px-3 py-2.5">
                      {line.issued_from.length ? (
                        <div className="flex flex-wrap gap-1.5">
                          {line.issued_from.map((f, idx) => (
                            <span
                              key={idx}
                              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface/60 px-2 py-0.5 text-[11px]"
                            >
                              <span className="font-mono text-text">{f.lot_number ?? 'No lot'}</span>
                              <span className="text-text-3">·</span>
                              {/* The shelf, with its ancestry on hover. A chip
                                  this narrow truncated the path at 160px, which
                                  ate the leaf and left the room prefix — the
                                  one part every chip in the row shares. */}
                              <span className="max-w-[160px] text-text-3">
                                <LocationPath path={f.location} />
                              </span>
                              <span className="font-mono tabular-nums text-text-2">×{f.qty}</span>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="min-w-0 text-xs text-text-3">
                          <LocationPath nodeId={line.source_location_node_id} />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <RuleNote>
        Issuing removes the quantity from the source lots immediately — kitted material stops
        counting as on hand. Adjust it on the Production step; reconcile and back-flush at close-out.
      </RuleNote>
    </div>
  );
}

// ── Production step ─────────────────────────────────────────────────────────

function ProductionStep({
  kit,
  canWrite,
  canReturn,
  busy,
  onIssueMore,
  onReturn,
}: {
  kit: ApiKit;
  canWrite: boolean;
  /** CTL-001 — Super Admin only. Issuing more is still ``canWrite``: material
   *  going OUT to the floor is not a return. */
  canReturn: boolean;
  busy: boolean;
  onIssueMore: (line: ApiKitLine) => void;
  onReturn: (line: ApiKitLine) => void;
}) {
  const editable = kit.status === 'issued' || kit.status === 'in_production';
  // Need is based on the planned target here — good/scrap are entered at
  // close-out now, so there's no dynamic need on this step (client 2026-07-22).
  const lineNeed = (l: ApiKitLine) => Math.ceil(Number(l.qty_per_unit) * kit.target_qty);
  const onFloorTotal = kit.lines.reduce((a, l) => a + l.on_floor_qty, 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Build target" value={kit.target_qty} hint={kit.item_number} />
        <Stat label="Components" value={kit.lines.length} hint="Staged on the floor" />
        <Stat label="On floor" value={onFloorTotal} hint="Total units in production" />
      </div>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Material on the floor</h2>
          <p className="mt-0.5 text-xs text-text-3">
            Adjust what&apos;s staged in production — <span className="text-text-2">issue more</span>{' '}
            if a component runs short, or <span className="text-text-2">return</span> the surplus.
            Needed is for the planned {kit.target_qty} unit{kit.target_qty === 1 ? '' : 's'}; the
            produced output and final reconciliation happen at close-out.
          </p>
        </div>
        {!editable ? (
          <RuleNote>This kit is {kit.status} — there is nothing on the floor to adjust.</RuleNote>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Needed</th>
                  <th className="px-3 py-2 text-right font-medium">Issued</th>
                  <th className="px-3 py-2 text-right font-medium">Additional</th>
                  <th className="px-3 py-2 text-right font-medium">Returned</th>
                  <th className="px-3 py-2 text-right font-medium">On floor</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Adjust</th>
                </tr>
              </thead>
              <tbody>
                {kit.lines.map((line) => {
                  const need = lineNeed(line);
                  const floor = line.on_floor_qty;
                  const short = floor < need;
                  const surplus = floor - need;
                  return (
                    <tr key={line.id} className="border-b border-border/60">
                      <td className="max-w-[240px] px-3 py-2">
                        <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={need} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={line.issued_qty} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell
                          value={line.additional_issued_qty || null}
                          tone={line.additional_issued_qty ? 'success' : 'muted'}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell
                          value={line.early_returned_qty || null}
                          tone={line.early_returned_qty ? 'success' : 'muted'}
                          title="Already handed back to inventory"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={floor} />
                      </td>
                      <td className="px-3 py-2">
                        {short ? (
                          <span className="text-xs text-warning">Short {need - floor}</span>
                        ) : surplus > 0 ? (
                          <span className="text-xs text-text-3">Surplus {surplus}</span>
                        ) : (
                          <span className="text-xs text-success">Exact</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canWrite || busy}
                          onClick={() => onIssueMore(line)}
                        >
                          <Plus size={12} /> Issue more
                        </Button>
                        {/* Disabled rather than hidden: the row's Returned
                            column already tells an operator the action exists,
                            so removing the button would look broken.

                            A greyed-out button with the reason hidden in a
                            hover title is not an explanation — it reads as the
                            app being broken (client 2026-09-01). So the reason
                            is VISIBLE beside the button, and the tooltip carries
                            the longer form for whoever wants it. Same principle
                            as the disabled Produce button on Close-Out. */}
                        {(() => {
                          // One place decides both whether the action is
                          // available and what to say when it is not, so the
                          // button and the sentence can never disagree.
                          const blocked = line.consumed_in_kit
                            ? {
                                short: 'Consumed to the kit',
                                long: 'Media is never returned — the leftover is discarded at close.',
                              }
                            : floor <= 0
                              ? {
                                  short: 'Nothing on the floor',
                                  long: 'Nothing is staged in production for this line.',
                                }
                              : !canReturn
                                ? {
                                    short: 'Super Admin only',
                                    long: 'Credits stock back, so it is Super Admin only and e-signed.',
                                  }
                                : null;

                          if (blocked) {
                            return (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex cursor-default items-center gap-1 px-2 text-xs text-text-3">
                                    <Ban size={11} aria-hidden />
                                    {blocked.short}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">
                                  Can’t return: {blocked.long}
                                </TooltipContent>
                              </Tooltip>
                            );
                          }
                          return (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              title="Return material to inventory"
                              onClick={() => onReturn(line)}
                            >
                              <Undo2 size={12} /> Return
                            </Button>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <RuleNote>
        Nothing here is final — adjust freely. The produced output is recorded and the leftover
        back-flushed at close-out, in one signed step.
      </RuleNote>
      {/* CTL-001 — say it once here rather than only in a tooltip, so an
          operator planning the day knows to line up a Super Admin. */}
      {!canReturn && editable && (
        <RuleNote>
          Returning material to inventory is restricted to a{' '}
          <span className="text-text-2">Super Admin</span>, and every return is recorded. You can
          still issue more.
        </RuleNote>
      )}
    </div>
  );
}

// ── Output placement (single, or split across locations) ────────────────────

/**
 * Where a produced batch is stocked. The common case is ONE location; when a
 * chosen LN2 box can't hold every unit, "Add another location" lets the rest of
 * the good units go to another box, a freezer, or a shelf (client 2026-07-23).
 * All rows are ONE lot; the quantities must sum to ``good``.
 *
 * A box row picks cells (quantity follows the selection, capped at what's left);
 * a bulk row (shelf / freezer) takes a typed quantity. ``BoxCellPicker`` reports
 * whether a location is a box, so we swap the cell grid for a quantity input.
 */
function OutputPlacement({
  good,
  dests,
  onChange,
  allowedIds,
  required,
  reservedFor,
  label = 'Stock the output to',
  noun = 'Output location',
  hideHeader = false,
}: {
  good: number;
  dests: OutputDest[];
  onChange: (next: OutputDest[]) => void;
  allowedIds: Set<string>;
  required: boolean;
  /** Cells claimed by other box pickers in the form (back-flush lines / other
   *  split rows), keyed off this row's node — blocked so no two claim one cell. */
  reservedFor: (nodeId: string | undefined, own: string[]) => Set<string>;
  /** Heading above the rows. Returns say "Return to", output says "Stock to". */
  label?: string;
  /** Singular, for the per-row aria labels. */
  noun?: string;
  /** Drop the heading row — a per-component card already names the component,
   *  so repeating "Return to" above every one is noise. */
  hideHeader?: boolean;
}) {
  const placed = dests.reduce((s, d) => s + destPlaced(d), 0);
  const remaining = good - placed;
  const update = (key: string, patch: Partial<OutputDest>) =>
    onChange(dests.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  return (
    <div className="space-y-3">
      <div
        className={cn(
          'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1',
          hideHeader && 'sr-only',
        )}
      >
        <label className="text-xs font-medium text-text-2">
          {label} {required && <span className="text-danger">*</span>}
        </label>
        {good > 0 && (
          <span
            className={cn(
              'font-mono text-xs tabular-nums',
              placed === good ? 'text-success' : 'text-text-3',
            )}
          >
            {placed} / {good} placed{remaining > 0 ? ` · ${remaining} to go` : ''}
          </span>
        )}
      </div>

      {dests.map((d, i) => {
        // This row's cap = the good count minus everything the OTHER rows hold.
        const cap = Math.max(0, good - (placed - destPlaced(d)));
        // A location already used by ANOTHER row is off the menu here — to put
        // more units in the same box you pick more cells in that box's own row,
        // not a second row (which the backend rejects as a duplicate anyway).
        const usedElsewhere = new Set(
          dests.filter((x) => x.key !== d.key).map((x) => x.location_node_id).filter(Boolean),
        );
        const rowAllowed = new Set([...allowedIds].filter((id) => !usedElsewhere.has(id)));
        return (
          <div key={d.key} className="rounded-lg border border-border bg-surface/40 p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <LocationTreePicker
                  aria-label={`${noun} ${i + 1}`}
                  value={d.location_node_id}
                  onChange={(v) =>
                    // Prefill the bulk quantity with what's still left to place
                    // (client 2026-07-24) — for a single location that equals the
                    // good count. A box overrides this once it resolves (below);
                    // its quantity follows the picked cells.
                    update(d.key, { location_node_id: v, isBox: false, cells: [], qty: cap })
                  }
                  areas={['storage']}
                  allowedNodeIds={rowAllowed}
                  showPath
                  placeholder="Warehouse, freezer, or LN2 box"
                />
              </div>
              {dests.length > 1 && (
                <button
                  type="button"
                  onClick={() => onChange(dests.filter((x) => x.key !== d.key))}
                  aria-label="Remove this location"
                  className="mt-1 grid size-8 shrink-0 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-2 hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {d.location_node_id && (
              <div className="mt-2">
                {/* Box → pick cells (quantity follows, capped at what's left).
                    Renders nothing for a shelf / freezer and reports back so we
                    show a quantity input instead. */}
                <BoxCellPicker
                  nodeId={d.location_node_id}
                  qty={cap}
                  derive
                  value={d.cells}
                  onChange={(cells) => update(d.key, { cells })}
                  onResolved={(isBox) => {
                    // A box derives its quantity from picked cells (clear qty); a
                    // bulk location keeps the prefilled remaining-to-place.
                    if (isBox !== d.isBox) update(d.key, { isBox, cells: [], qty: isBox ? null : cap });
                  }}
                  reserved={reservedFor(d.location_node_id, d.cells)}
                />
                {!d.isBox && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-3">Quantity here</span>
                    <NumberInput
                      aria-label={`${noun} ${i + 1} quantity`}
                      value={d.qty}
                      min={1}
                      onChange={(v) => update(d.key, { qty: v == null ? null : Math.min(v, cap) })}
                      className="h-8 w-20"
                    />
                    <span className="text-[11px] text-text-3">of {cap} left</span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}


      {required && good > 0 && placed !== good && (
        <p className="text-xs text-danger">
          {placed < good
            ? `Place all ${good} unit${good === 1 ? '' : 's'} — ${remaining} still to place.`
            : `Too many placed — remove ${placed - good}.`}
        </p>
      )}

      {remaining > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange([...dests, emptyDest()])}
        >
          <Plus size={14} /> Add another location
        </Button>
      )}
    </div>
  );
}

// ── Close-out step ──────────────────────────────────────────────────────────

function CloseOutStep({
  kit,
  output,
  onOutputChange,
  outputAllowedIds,
  outputDests,
  onOutputDests,
  used,
  onUsed,
  returnRowsFor,
  onReturnDests,
  returnPlaced,
  returnAllowedIds,
  lotStatus,
}: {
  kit: ApiKit;
  output: OutputDraft;
  onOutputChange: (o: OutputDraft) => void;
  outputAllowedIds: Set<string>;
  outputDests: OutputDest[];
  onOutputDests: (next: OutputDest[]) => void;
  used: Record<string, number | null>;
  onUsed: (id: string, v: number | null) => void;
  /** A line's back-flush destination rows, defaulted to one at its source. */
  returnRowsFor: (line: ApiKitLine) => OutputDest[];
  onReturnDests: (lineId: string, next: OutputDest[]) => void;
  /** Units of a line's leftover already placed across its destinations. */
  returnPlaced: (line: ApiKitLine) => number;
  returnAllowedIds: Set<string>;
  /** Live availability of the typed produced lot number (checked upstream). */
  lotStatus: 'unknown' | 'checking' | 'free' | 'taken';
}) {
  const closed = kit.status === 'closed';
  const cancelled = kit.status === 'cancelled';
  const editable = kit.status === 'issued' || kit.status === 'in_production';
  // The produced output is entered HERE (KIT-005), then posted with either
  // "Produce" (keep open) or the signed close on the Review step.
  const goodQty = closed ? kit.good_qty : output.good_qty;
  const scrapQty = closed ? kit.scrap_qty : output.scrap_qty;
  const expiryBad = Boolean(output.output_expiration_date) && output.output_expiration_date < todayStr();
  const lotMissing = !output.output_lot_number.trim();
  const lotTaken = lotStatus === 'taken';
  // Good/scrap accumulate across produce batches (KIT-007). A good of 0 is only
  // valid at CLOSE once earlier batches already produced something.
  const priorGood = kit.good_qty ?? 0;
  const goodRequired = priorGood < 1; // must make ≥ 1 this batch if nothing made yet
  const producingNow = (goodQty ?? 0) >= 1;

  if (kit.status === 'draft') {
    return (
      <Card className="p-4">
        <RuleNote>Close-out reconciles issued vs. used. Issue the kit first.</RuleNote>
      </Card>
    );
  }
  if (cancelled) {
    return (
      <Card className="p-4">
        <RuleNote>This kit was cancelled — nothing was issued, so there is nothing to reconcile.</RuleNote>
      </Card>
    );
  }

  // The operator ENTERS Used per component (client 2026-07-23); Needed is the
  // recipe minimum ceil(qty_per_unit × (good+scrap)). Used must be ≥ Needed and
  // ≤ on-floor; the leftover (floor − used) back-flushes at close.
  const attempted = (goodQty ?? 0) + (scrapQty ?? 0);
  // See the parent: an ordinary kit scales the recipe by the batch; a
  // variable-yield kit takes one unit's worth however much it yields, because
  // the output must not drive the input but nothing is made from nothing.
  const recipeUnits = attempted === 0 ? 0 : kit.variable_yield ? 1 : attempted;
  const lineNeed = (l: ApiKitLine) => Math.ceil(Number(l.qty_per_unit) * recipeUnits);
  // Changing good/scrap re-syncs each line's Used to the recipe need, so the
  // Used column tracks the target (client 2026-07-23). The operator can still
  // override a line afterwards.
  const setBatch = (next: OutputDraft) => {
    onOutputChange(next);
    const att = (next.good_qty ?? 0) + (next.scrap_qty ?? 0);
    // The same `recipeUnits` rule the gate and the Min / run column use, so the
    // number that lands in Used is exactly the minimum shown beside it:
    //
    //   nothing made        → 0. A batch making nothing consumes nothing, and
    //                         this clears even a typed figure — closing with
    //                         good 0 means "back-flush the rest", so material
    //                         left here would be destroyed rather than returned.
    //   variable-yield kit  → one run's worth. It does NOT scale with the
    //                         quantity made (that coupling is what YLD-001
    //                         removed), so it stays a small, stable seed the
    //                         operator adjusts to what the run actually took.
    //   ordinary kit        → the recipe scaled by the batch, unchanged.
    const units = att === 0 ? 0 : kit.variable_yield ? 1 : att;
    for (const l of kit.lines) {
      onUsed(l.id, Math.ceil(Number(l.qty_per_unit) * units));
    }
  };
  const usedOf = (l: ApiKitLine) => (editable ? used[l.id] : l.used_qty);
  const anyProblem =
    editable &&
    kit.lines.some((l) => {
      const u = used[l.id];
      return u == null || u > l.on_floor_qty || u < lineNeed(l);
    });
  const consumeTotal = kit.lines.reduce((a, l) => a + (usedOf(l) ?? 0), 0);
  const leftTotal = kit.lines.reduce(
    (a, l) => a + Math.max(0, l.on_floor_qty - (usedOf(l) ?? 0)),
    0,
  );
  const yieldPct = attempted > 0 ? (goodQty ?? 0) / attempted : null;

  // Cells claimed by EVERY box picker in this form (the split-output rows AND
  // the back-flush lines), keyed by node. A cell taken by one picker is blocked
  // in the others so the produced output and a back-flush can share a box but
  // never the same physical position. Recomputed each render → reserves live.
  const claimedByNode = new Map<string, Set<string>>();
  const claimCells = (nodeId: string | undefined, keys: string[]) => {
    if (!nodeId || keys.length === 0) return;
    const set = claimedByNode.get(nodeId) ?? new Set<string>();
    keys.forEach((k) => set.add(k));
    claimedByNode.set(nodeId, set);
  };
  outputDests.forEach((d) => {
    if (d.isBox) claimCells(d.location_node_id, d.cells);
  });
  // Every back-flush destination row on every line — a split claims cells in
  // more than one box, and two lines must not both take the same one.
  kit.lines.forEach((l) =>
    returnRowsFor(l).forEach((d) => {
      if (d.isBox) claimCells(d.location_node_id, d.cells);
    }),
  );
  const reservedFor = (nodeId: string | undefined, own: string[]): Set<string> => {
    const all = nodeId ? claimedByNode.get(nodeId) : undefined;
    if (!all) return new Set();
    const ownSet = new Set(own);
    return new Set([...all].filter((k) => !ownSet.has(k)));
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Making (good)" value={goodQty ?? 0} tone="success" hint="This batch" />
        <Stat
          label="Scrapped"
          value={scrapQty ?? 0}
          tone={(scrapQty ?? 0) > 0 ? 'danger' : 'default'}
          hint="Consumed, no output"
        />
        <Stat
          label={editable ? 'Consumes' : 'Consumed'}
          value={consumeTotal}
          tone={anyProblem ? 'danger' : 'default'}
          hint={editable ? 'Material from the floor' : 'Total across batches'}
        />
        <Stat
          label="Left on floor"
          value={leftTotal}
          tone="success"
          hint={editable ? 'Back-flushes at close' : 'Back-flushed'}
        />
      </div>

      {/* Production output — entered here, posted by Produce (keep open) or Close. */}
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-text">This batch</h2>
            <p className="mt-0.5 text-xs text-text-3">
              {closed
                ? 'Posted at close-out.'
                : priorGood > 0
                  ? `${priorGood} already produced. Enter the next batch, then Produce (keep open) or Sign & close.`
                  : 'What this batch yielded — post it with Produce (keep open) or Sign & close.'}
            </p>
          </div>
          {yieldPct !== null && (
            <span
              className={cn(
                'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium',
                yieldPct >= 1
                  ? 'bg-success-soft text-success'
                  : yieldPct >= 0.8
                    ? 'bg-warning-soft text-warning'
                    : 'bg-danger-soft text-danger',
              )}
            >
              {Math.round(yieldPct * 100)}% yield
            </span>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">Quantity made (good)</label>
            <NumberInput
              aria-label="Quantity made"
              value={goodQty}
              min={0}
              disabled={closed}
              invalid={!closed && goodRequired && (goodQty ?? 0) < 1}
              onChange={(v) => setBatch({ ...output, good_qty: v })}
              className="h-8 w-full"
            />
            {!closed && goodRequired && (goodQty ?? 0) < 1 ? (
              <p className="mt-1 text-xs text-danger">Must be at least 1 good unit.</p>
            ) : (
              !closed &&
              !goodRequired &&
              (goodQty ?? 0) < 1 && (
                <p className="mt-1 text-[11px] text-text-3">0 is fine — closing just back-flushes.</p>
              )
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">Quantity scrapped</label>
            <NumberInput
              aria-label="Quantity scrapped"
              value={scrapQty}
              disabled={closed}
              onChange={(v) => setBatch({ ...output, scrap_qty: v })}
              className="h-8 w-full"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">
              Expiry of the {kit.item_number}
            </label>
            <Input
              type="date"
              aria-label="Output expiry date"
              value={closed ? '' : output.output_expiration_date}
              min={todayStr()}
              disabled={closed}
              onChange={(e) => onOutputChange({ ...output, output_expiration_date: e.target.value })}
            />
            {!closed && expiryBad ? (
              <p className="mt-1 text-xs text-danger">Expiry can’t be in the past.</p>
            ) : (
              <p className="mt-1 text-[11px] text-text-3">Optional — carried onto the produced lot.</p>
            )}
          </div>
          {/* Operator-entered lot number for this produced batch (client
              2026-07-24 — replaces the old auto KIT-0289-N suffix). Required when
              this batch makes output; must be globally unique (checked server-side). */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">Lot number</label>
            <Input
              type="text"
              aria-label="Produced lot number"
              value={closed ? '' : output.output_lot_number}
              disabled={closed}
              aria-invalid={!closed && producingNow && (lotMissing || lotTaken)}
              wrapperClassName={cn(
                !closed && producingNow && (lotMissing || lotTaken) && 'border-danger',
              )}
              placeholder="Lot"
              onChange={(e) => onOutputChange({ ...output, output_lot_number: e.target.value })}
            />
            {!closed && producingNow && lotMissing ? (
              <p className="mt-1 text-xs text-danger">Enter the produced lot number.</p>
            ) : !closed && producingNow && lotTaken ? (
              /* Surfaced here so a taken number blocks on Close-Out rather than
                 after the operator reaches Review and signs (client 2026-07-28). */
              <p className="mt-1 text-xs text-danger">
                Lot “{output.output_lot_number.trim()}” is already used. Enter a different one.
              </p>
            ) : !closed && producingNow && lotStatus === 'checking' ? (
              <p className="mt-1 text-[11px] text-text-3">Checking availability…</p>
            ) : !closed && producingNow && lotStatus === 'free' ? (
              <p className="mt-1 text-[11px] text-success">Lot number is available.</p>
            ) : (
              <p className="mt-1 text-[11px] text-text-3">Assigned to the produced batch.</p>
            )}
          </div>
        </div>

        {/* Where the produced units go — one location, or SPLIT across several
            (client 2026-07-23) when one LN2 box can't hold every unit. */}
        {!closed ? (
          <div className="mt-4 border-t border-border pt-4">
            <OutputPlacement
              good={goodQty ?? 0}
              dests={outputDests}
              onChange={onOutputDests}
              allowedIds={outputAllowedIds}
              required={producingNow}
              reservedFor={reservedFor}
            />
          </div>
        ) : (
          kit.output_location_node_id && (
            <div className="mt-4 border-t border-border pt-4">
              <label className="mb-1.5 block text-xs font-medium text-text-2">Stocked the output to</label>
              <LocationTreePicker
                aria-label="Output location"
                value={kit.output_location_node_id}
                onChange={() => {}}
                areas={['storage']}
                disabled
                showPath
              />
            </div>
          )
        )}
      </Card>

      {editable ? (
        <Card className="p-4">
          <div className="mb-3">
            <h2 className="text-sm font-medium text-text">Material this batch consumes</h2>
            <p className="mt-0.5 text-xs text-text-3">
              {kit.variable_yield ? (
                <>
                  Enter how much of each component you used. This item is{' '}
                  <span className="text-text-2">grown</span>, so how much comes out
                  doesn&apos;t change what goes in —{' '}
                  <span className="text-text-2">Min / run</span> is what a single run
                  takes whether it yields a little or a lot, and it stays the minimum. No
                  more than what&apos;s on the floor. The leftover back-flushes when you{' '}
                  <span className="text-text-2">close</span>.
                </>
              ) : (
                <>
                  Enter how much of each component you used. It must be at least the recipe{' '}
                  <span className="text-text-2">Needs</span> — making {attempted} unit
                  {attempted === 1 ? '' : 's'} takes at least that much — and no more than
                  what&apos;s on the floor. The leftover back-flushes when you{' '}
                  <span className="text-text-2">close</span>.
                </>
              )}
              {kit.lines.some((l) => l.consumed_in_kit) && (
                <>
                  {' '}
                  Media is the exception: whatever is still on the floor at close is
                  <span className="text-text-2"> consumed</span>, never returned.
                </>
              )}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                  <th className="px-3 py-2 font-medium">Component</th>
                  <th className="px-3 py-2 text-right font-medium">Per unit</th>
                  {/* On a variable-yield kit this column is one run's worth, not
                      a figure scaled to the batch — "Needs" would read as though
                      it still tracked the quantity made. */}
                  <th className="px-3 py-2 text-right font-medium">
                    {kit.variable_yield ? 'Min / run' : 'Needs'}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">On floor</th>
                  <th className="px-3 py-2 text-right font-medium">Used</th>
                  <th className="px-3 py-2 text-right font-medium">Left</th>
                  <th className="px-3 py-2 font-medium">Back-flush to (at close)</th>
                </tr>
              </thead>
              <tbody>
                {kit.lines.map((line) => {
                  // A media line's leftover is poured at sign-out rather than
                  // returned (KIT-003), so it asks for no destination. In every
                  // other respect it is an ordinary component.
                  const media = line.consumed_in_kit;
                  const need = lineNeed(line);
                  const floor = line.on_floor_qty;
                  const u = used[line.id];
                  const left = floor - (u ?? 0);
                  // `need` already carries the variable-yield rule, so both
                  // checks stay live: on such a kit they simply measure against
                  // one run's worth instead of the batch's, which is what keeps
                  // the client's 350-off-200 example green while still refusing
                  // a batch recorded as consuming nothing.
                  const cantMake = need > floor; // even the minimum doesn't fit
                  const belowNeed = u != null && u < need;
                  const overFloor = u != null && u > floor;
                  const rowBad = cantMake || belowNeed || overFloor;
                  // Nothing is being made, yet material is recorded as used —
                  // legitimate for a run that died consuming its charge, but the
                  // consequence is easy to miss: it is CONSUMED, not returned.
                  // Advisory, so `rowBad` deliberately excludes it.
                  const consumedForNothing = attempted === 0 && (u ?? 0) > 0;
                  return (
                    <React.Fragment key={line.id}>
                      <tr className={cn('border-b border-border/60', rowBad && 'bg-danger-soft/30')}>
                        <td className="max-w-[240px] px-3 py-2">
                          <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-text-2">
                          {Number(line.qty_per_unit)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <QtyCell value={need} tone={cantMake ? 'danger' : undefined} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <QtyCell value={floor} tone={cantMake ? 'danger' : undefined} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <NumberInput
                            aria-label={`Used for ${line.item_number}`}
                            value={u ?? null}
                            min={0}
                            invalid={belowNeed || overFloor || cantMake}
                            onChange={(v) => onUsed(line.id, v)}
                            className="w-16"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          {u == null ? (
                            <span className="text-xs text-text-3">—</span>
                          ) : (
                            <QtyCell value={left} tone={left > 0 ? 'success' : 'muted'} />
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {media ? (
                            // KIT-003: whatever is still on the floor at sign-out
                            // is poured, so there is no destination to pick.
                            <span className="text-xs text-text-3">
                              {left > 0
                                ? // Drained off the floor and gone, but NOT
                                  // charged to this batch's lot — the lot pays
                                  // for what you recorded in Used. Named
                                  // "discarded" rather than "consumed" so the
                                  // two are not read as the same event.
                                  `Discarded at close (${left})`
                                : 'Consumed'}
                            </span>
                          ) : left > 0 ? (
                            // The destinations themselves live in the full-width
                            // row below — a split needs more room than a table
                            // cell. This says how much of the leftover is placed.
                            <span
                              className={cn(
                                'font-mono text-xs tabular-nums',
                                returnPlaced(line) === left ? 'text-success' : 'text-text-3',
                              )}
                            >
                              {returnPlaced(line)} / {left} placed
                            </span>
                          ) : (
                            <span className="text-xs text-text-3">Nothing left</span>
                          )}
                        </td>
                      </tr>
                      {(cantMake || belowNeed || overFloor) && (
                        <tr className="bg-danger-soft/30">
                          <td colSpan={7} className="px-3 pb-2 text-xs text-danger">
                            {cantMake
                              ? kit.variable_yield
                                ? `Not enough on the floor — one run takes ${need}, only ${floor} here. Issue more first.`
                                : `Not enough on the floor — ${need} needed to make ${attempted}, only ${floor} here. Issue more first.`
                              : belowNeed
                                ? kit.variable_yield
                                  ? `Use at least ${need} — one run takes that much whatever it yields.`
                                  : `Use at least ${need} to make ${attempted} unit${attempted === 1 ? '' : 's'}.`
                                : `Only ${floor} on the floor.`}
                          </td>
                        </tr>
                      )}
                      {/* Not an error — a failed run writing off its charge is a
                          real thing to record. It just must not happen by
                          accident, because the material does not come back. */}
                      {!rowBad && consumedForNothing && (
                        <tr className="bg-warning-soft/30">
                          <td colSpan={7} className="px-3 pb-2 text-xs text-warning">
                            Nothing is being made, so this {u} will be consumed, not
                            returned. Leave it at 0 to back-flush it instead.
                          </td>
                        </tr>
                      )}
                      {/* Where the leftover goes — one row, or several when no
                          single box has enough free cells. Full width because a
                          split carries a cryobox grid per destination. */}
                      {left > 0 && !media && (
                        <tr className="border-b border-border/60 bg-surface/40">
                          <td colSpan={7} className="px-3 pb-3 pt-2">
                            <div className="max-w-xl">
                              <OutputPlacement
                                good={left}
                                dests={returnRowsFor(line)}
                                onChange={(next) => onReturnDests(line.id, next)}
                                allowedIds={returnAllowedIds}
                                required
                                reservedFor={reservedFor}
                                label={`Back-flush ${line.item_number} to`}
                                noun={`Back-flush location for ${line.item_number}`}
                              />
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card className="p-4">
          <RuleNote>Posted — see the Review step for the full component summary.</RuleNote>
        </Card>
      )}

      {closed && (
        <Card className="flex items-start gap-3 border-success/30 bg-success-soft/40 p-4">
          <Check size={16} className="mt-0.5 shrink-0 text-success" />
          <div className="text-sm">
            <div className="font-medium text-text">Kit closed</div>
            <p className="mt-1 text-xs text-text-2">
              {kit.good_qty} × {kit.item_number} stocked
              {(kit.scrap_qty ?? 0) > 0 && ` (${kit.scrap_qty} scrapped)`}, and {leftTotal} unit
              {leftTotal === 1 ? '' : 's'} back-flushed to inventory.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Review & Close step ──────────────────────────────────────────────────────

function ReviewStep({
  kit,
  output,
  outputDests,
  used,
  returnLoc,
  prodName,
  canClose,
}: {
  kit: ApiKit;
  output: OutputDraft;
  /** Where this batch's units go — one row, or several when the batch is SPLIT
   *  across locations (client 2026-07-23). Review used to render only the draft's
   *  single ``output_location_node_id``, which was wrong for a split batch. */
  outputDests: OutputDest[];
  used: Record<string, number | null>;
  returnLoc: Record<string, string>;
  /** Resolved production-floor name (production nodes aren't in nodeOptions). */
  prodName: string;
  /** CTL-001 — false for everyone but a Super Admin. The step stays readable
   *  either way; only the wording of what happens next changes. */
  canClose: boolean;
}) {
  const closed = kit.status === 'closed';
  // Cancelled counts as FINISHED for anything phrased in tense: the floor is
  // empty either way and the media is already gone. `closed` alone would tell a
  // cancelled kit's reader that material is "still on the floor" and that media
  // will be "discarded at close" — both future tense, on a kit that has ended.
  const finished = closed || kit.status === 'cancelled';
  // Good/scrap accumulate on the kit across produce batches (KIT-007).
  const producedSoFar = kit.good_qty ?? 0;
  const scrapSoFar = kit.scrap_qty ?? 0;
  const pendingGood = closed ? 0 : (output.good_qty ?? 0); // a batch entered but not yet made
  const pendingScrap = closed ? 0 : (output.scrap_qty ?? 0);
  const producingNow = pendingGood >= 1;
  const totalMade = producedSoFar + scrapSoFar;
  const yieldPct = totalMade > 0 ? producedSoFar / totalMade : null;
  // A ``label(nodeId)`` helper used to turn a node id into the picker's own
  // option text, which was the full path. ``LocationPath`` resolves the id
  // against the shared location forest instead, so it renders the leaf, hovers
  // the hierarchy and links — and the display no longer borrows a string that
  // exists to disambiguate a dropdown.
  // ``on_floor_qty`` already nets out cumulative used, so it is the material
  // still physically on the floor — which is exactly what back-flushes at close.
  const floorTotal = kit.lines.reduce((a, l) => a + l.on_floor_qty, 0);
  const usedTotal = kit.lines.reduce((a, l) => a + (l.used_qty ?? 0), 0);
  // KIT-003 splits the floor in two at close: media is poured, everything else
  // is handed back. The copy below has to say which, because "N units still on
  // the floor back-flush to inventory" is a promise the close-out will not keep
  // for the media half of that number.
  const floorPoured = kit.lines.reduce(
    (a, l) => a + (l.consumed_in_kit ? l.on_floor_qty : 0),
    0,
  );
  const floorReturned = floorTotal - floorPoured;
  const router = useRouter();
  const pathname = usePathname();
  /** The lot segment of ``/review/<lot>``, if the panel is open. */
  const openBatchKey = React.useMemo(() => {
    const parts = pathname.split('/').filter(Boolean);
    const at = parts.indexOf('review');
    const lot = at === -1 ? undefined : parts[at + 1];
    return lot ? decodeURIComponent(lot) : null;
  }, [pathname]);
  // The open batch breakdown is a route of its own —
  // ``/reconciliation/<kit>/review/<lot>`` — so it is linkable, survives a
  // refresh, and a lot number clicked anywhere else in the app lands straight
  // on it. Keyed by lot number because that is what the rest of the system
  // quotes; a batch that scrapped everything has no lot, so it falls back to id.
  const batchDetail =
    openBatchKey === null
      ? null
      : (kit.batches.find(
          (b) => b.output_lot_number === openBatchKey || b.id === openBatchKey,
        ) ?? null);
  const reviewHref = `/reconciliation/${kit.id}/review`;
  const showBatch = (b: ApiKitBatch) =>
    router.push(`${reviewHref}/${encodeURIComponent(b.output_lot_number ?? b.id)}`, {
      scroll: false,
    });
  const hideBatch = () => router.push(reviewHref, { scroll: false });
  // RPT-003. What the kit has been CHARGED but never handed to a finished lot.
  // The same subtraction means two different things depending on where the kit
  // is: while it is OPEN that value is still staged on the production floor;
  // once it is CLOSED the floor is empty, so what is left over is media that was
  // discarded at sign-out (KIT-003) — drained, never returned, and charged to no
  // lot. Labelling a closed kit's figure "still on the floor" claimed material
  // was somewhere it no longer is (user, 2026-09-01).
  //
  // `null` when either side is unknown — subtracting from an unknown total is
  // not a number anyone should read.
  const costUnattributed =
    kit.material_cost_amount === null || kit.consumed_value_amount === null
      ? null
      : Number(kit.material_cost_amount) - Number(kit.consumed_value_amount);
  // A kit closed BEFORE per-batch costing existed carries no batch rows at all,
  // so nothing was ever attributed to a lot and the ENTIRE charge falls into the
  // leftover above. It was not discarded — the units were made and stocked — it
  // was never costed, and there is no record left from which to cost it. Saying
  // "discarded" there reports real product cost as waste: KIT-0004 read
  // "$687.50 discarded" three lines above "50 × AY-002 stocked" (client,
  // 2026-09-01). Distinct from a kit that produced nothing and was cancelled,
  // which never charged anything to fall through in the first place.
  const neverCosted = kit.batches.length === 0;
  // RPT-003. Summed from the batches, not recomputed from the kit total: each
  // batch's scrap was valued at ITS unit cost, which differs between batches
  // when the material mix changed. `null` if any batch is unpriced — a partial
  // scrap figure would understate the loss while looking authoritative.
  const scrapValueTotal = kit.batches.some((b) => !b.cost_is_complete)
    ? null
    : kit.batches.length > 0
      ? String(
          kit.batches.reduce((a, b) => a + Number(b.scrap_value_amount ?? 0), 0),
        )
      : null;
  // Both come from the close-out draft. The batch card below only renders while
  // a batch is pending (never once closed), so there is no closed-kit branch to
  // take here — ApiKit doesn't carry the produced expiry anyway.
  const lotNumber = output.output_lot_number.trim();
  const expiry = output.output_expiration_date;
  // Destinations actually filled in. Falls back to the kit's stored output
  // location once closed, when the draft is empty.
  const dests = outputDests.filter((d) => d.location_node_id && destPlaced(d) > 0);

  return (
    <div className="space-y-4">
      {/* ── THIS BATCH — everything the signature covers, in one place ── */}
      {producingNow && (
        <Card className="overflow-hidden border-accent/40">
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4 bg-accent-soft/15 p-5">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-accent">This batch</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-3xl font-semibold text-text">{pendingGood}</span>
                <span className="text-text-3">×</span>
                <span className="font-mono text-lg text-text">{kit.item_number}</span>
                {pendingScrap > 0 && <Badge tone="danger">{pendingScrap} scrap</Badge>}
              </div>
              <div className="mt-0.5 text-sm text-text-2">{kit.description}</div>
            </div>

            {/* The produced lot + its expiry — what the operator typed at
                close-out, and the identity every unit in this batch carries.
                It was missing from Review entirely (client 2026-07-28). */}
            <dl className="flex shrink-0 gap-8 text-sm">
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-text-3">Lot</dt>
                <dd className="mt-0.5 font-mono text-text">{lotNumber || '—'}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-text-3">Expiry</dt>
                <dd className="mt-0.5 font-mono text-text-2">{expiry || 'None'}</dd>
              </div>
            </dl>
          </div>

          {/* Where the units land — a list, because one batch can be SPLIT
              across several boxes / shelves when a box can't hold it all. */}
          <div className="border-t border-border px-5 py-3">
            <div className="text-[11px] uppercase tracking-wider text-text-3">Stocking to</div>
            <ul className="mt-1 space-y-0.5">
              {dests.length === 0 ? (
                <li className="text-sm text-text-3">—</li>
              ) : (
                dests.map((d) => (
                  <li key={d.key} className="flex items-baseline gap-2 text-sm">
                    <ArrowRight size={12} className="shrink-0 text-text-3" aria-hidden />
                    <span className="min-w-0 text-text">
                      <LocationPath nodeId={d.location_node_id} />
                    </span>
                    <span className="font-mono tabular-nums text-text-2">×{destPlaced(d)}</span>
                    {d.isBox && (
                      <span className="text-[11px] text-text-3">
                        {d.cells.length} cell{d.cells.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </li>
                ))
              )}
            </ul>
          </div>

          {/* The ONE component table: where it came from → what this batch
              uses → what's left → where the leftover goes. Replaces the two
              overlapping tables Review used to stack (client 2026-07-28). */}
          <ComponentReviewTable
            kit={kit}
            mode="batch"
            used={used}
            returnLoc={returnLoc}
            closed={closed}
          />
        </Card>
      )}

      {/* ── THE KIT — running totals, one compact strip ── */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-text-3">
                {closed ? 'Produced' : 'Produced so far'}
              </span>
              {!closed && <Badge tone="warning">Kit open</Badge>}
            </div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-text">{producedSoFar}</span>
              {!closed && <span className="text-sm text-text-3">of {kit.target_qty}</span>}
              <span className="font-mono text-sm text-text-2">{kit.item_number}</span>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
            {yieldPct !== null && (
              <ReviewStat label="Yield">
                <span
                  className={cn(
                    'font-semibold',
                    yieldPct >= 1
                      ? 'text-success'
                      : yieldPct >= 0.8
                        ? 'text-warning'
                        : 'text-danger',
                  )}
                >
                  {Math.round(yieldPct * 100)}%
                </span>
                <span className="ml-1.5 text-[11px] text-text-3">
                  {producedSoFar} good · {scrapSoFar} scrap
                </span>
              </ReviewStat>
            )}
            <ReviewStat label="Built at">{prodName || 'Production floor'}</ReviewStat>
            <ReviewStat label={closed ? 'Consumed / returned' : 'Consumed / on floor'}>
              <span className="font-mono tabular-nums">{usedTotal}</span> used ·{' '}
              <span className="font-mono tabular-nums">{floorTotal}</span>{' '}
              {closed ? 'returned' : 'on floor'}
            </ReviewStat>
            {/* RPT-003. Net of returns, so handing material back lowers it.
                "—  unpriced material" rather than $0.00 when an input lot has
                no price: blank means unknown, zero means free, and the $0
                customer-owned cells make that a distinction with real money
                behind it.

                Labelled CHARGED, not "Material cost", and split below. This is
                everything pulled onto the floor; the per-lot figures in the
                table beneath are what batches have actually CONSUMED, and until
                the kit closes those are different numbers. Two stats inches
                apart both reading "Material cost" and disagreeing is a bug
                report waiting to happen — it was one (user, 2026-08-31). */}
            <ReviewStat label="Material charged">
              {kit.cost_is_complete ? (
                <>
                  <span className="font-mono tabular-nums font-semibold text-text">
                    {formatMoney(kit.material_cost_amount)}
                  </span>
                  {costUnattributed !== null && costUnattributed > 0 && (
                    <div className="text-[11px] text-text-3">
                      <span className="font-mono tabular-nums">
                        {formatMoney(kit.consumed_value_amount)}
                      </span>{' '}
                      to lots ·{' '}
                      <span className="font-mono tabular-nums">
                        {formatMoney(String(costUnattributed))}
                      </span>{' '}
                      {finished
                        ? neverCosted
                          ? 'never costed to a lot'
                          : 'discarded'
                        : 'still on the floor'}
                    </div>
                  )}
                </>
              ) : (
                <span className="text-text-3">
                  — <span className="text-[11px]">unpriced material</span>
                </span>
              )}
            </ReviewStat>
            {/* "Of which" is deliberate wording: the scrap value is a PORTION
                of the material cost above, not an extra charge on top. The
                scrapped units' material was charged at issue; what bills it to
                the customer is dividing by good units alone. */}
            {scrapValueTotal !== null && scrapSoFar > 0 && (
              <ReviewStat label="Of which scrap">
                <span className="font-mono tabular-nums text-warning">
                  {formatMoney(scrapValueTotal)}
                </span>
                <span className="ml-1.5 text-[11px] text-text-3">
                  {scrapSoFar} unit{scrapSoFar === 1 ? '' : 's'}
                </span>
              </ReviewStat>
            )}
          </div>
        </div>

        {!closed && pendingGood > 0 && (
          <p className="mt-3 border-t border-border pt-3 text-xs text-accent">
            Sign &amp; close will make {pendingGood} more, then finish the kit.
          </p>
        )}
      </Card>

      {/* Per-batch cost (RPT-003). Shown as soon as a kit has produced ANYTHING:
          the client bills per finished lot — "the Kit is closed out to the FG Lot
          specifically so the Customer can be charged the actual cost for that
          particular FG Lot" — and nothing else on this step names the lot that
          was minted. It was briefly gated on two-or-more batches, on the theory
          that one lot is already covered by the kit-level "Material cost" above;
          that was wrong (user, 2026-08-31). The header figure is a kit total, not
          a lot, so a kit with exactly one batch showed its output lot NOWHERE
          once the pending-batch card had gone.

          These figures are FROZEN at produce time, unlike the kit total above,
          which re-reads lot prices every time this page loads. If a price was
          corrected after a batch was made the two will differ, and they should:
          a shipped lot's cost must not move retroactively. */}
      {kit.batches.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium text-text">Lots produced by this kit</h2>
            <p className="mt-0.5 text-xs text-text-3">
              Each batch carries its own material cost. Scrap is included — the
              per-unit figure divides by good units only.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[11px] uppercase tracking-wider text-text-3">
                  <th className="px-4 py-2 text-left font-medium">Batch</th>
                  <th className="px-4 py-2 text-left font-medium">Lot</th>
                  <th className="px-4 py-2 text-right font-medium">Good</th>
                  <th className="px-4 py-2 text-right font-medium">Scrap</th>
                  <th className="px-4 py-2 text-right font-medium">Material cost</th>
                  <th className="px-4 py-2 text-right font-medium">Per unit</th>
                </tr>
              </thead>
              <tbody>
                {kit.batches.map((b) => (
                  <tr
                    key={b.id}
                    onClick={() => showBatch(b)}
                    className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-surface/60"
                    title="See how this lot was made"
                  >
                    <td className="px-4 py-2 tabular-nums text-text-2">{b.batch_no}</td>
                    <td className="px-4 py-2 font-mono text-accent underline-offset-2 hover:underline">
                      {b.output_lot_number ??
                        (b.scrap_qty > 0 ? (
                          <span className="text-text-3">no lot · all scrapped</span>
                        ) : (
                          // good 0 AND scrap 0: the close-out's own finalising
                          // batch, which makes nothing and mints no lot. Calling
                          // that "all scrapped" claimed a loss that never
                          // happened (user, 2026-09-01).
                          <span className="text-text-3">no lot · nothing made</span>
                        ))}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">
                      {b.good_qty}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums text-text-3">
                      {b.scrap_qty || '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">
                      {b.cost_is_complete ? (
                        formatMoney(b.material_cost_amount)
                      ) : (
                        <span className="text-text-3" title="An input lot had no price">
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums font-semibold">
                      {b.cost_is_complete ? (
                        formatMoney(b.unit_cost_amount)
                      ) : (
                        <span className="font-normal text-text-3">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <BatchDetailSheet batch={batchDetail} kit={kit} onClose={hideBatch} />

      {/* The kit-level component picture. Shown on its own only when there is no
          batch above — otherwise the batch table already covers the components
          and repeating them is what made this page hard to read. */}
      {!producingNow && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium text-text">Components</h2>
            <p className="mt-0.5 text-xs text-text-3">
              {closed
                ? 'What the kit consumed and what returned to inventory.'
                : floorPoured > 0
                  ? 'Consumed so far and what is still staged on the floor — at close the leftover back-flushes, except media, which is consumed.'
                  : 'Consumed so far and what is still staged on the floor — the remainder back-flushes at close.'}
            </p>
          </div>
          <ComponentReviewTable
            kit={kit}
            mode="kit"
            used={used}
            returnLoc={returnLoc}
            closed={closed}
          />
        </Card>
      )}

      {closed ? (
        <Card className="flex items-start gap-3 border-success/30 bg-success-soft/40 p-4">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
          <div className="text-sm">
            <div className="font-medium text-text">Kit closed</div>
            <p className="mt-1 text-xs text-text-2">
              {producedSoFar} × {kit.item_number} stocked
              {scrapSoFar > 0 && ` (${scrapSoFar} scrapped)`}; {floorTotal} unit
              {floorTotal === 1 ? '' : 's'} back-flushed to inventory.
            </p>
          </div>
        </Card>
      ) : canClose ? (
        <RuleNote>
          <span className="text-text-2">Produce another batch</span> to make more (the kit stays
          open), or <span className="text-text-2">Sign &amp; close</span> to finish.{' '}
          {/* What the close actually does with the floor. KIT-003 splits it:
              media is poured, everything else is handed back — so the two halves
              are named separately rather than promising a back-flush of units
              that will never see one. */}
          {floorReturned > 0 && (
            <>
              The {floorReturned} unit{floorReturned === 1 ? '' : 's'} still on the floor
              back-flush{floorReturned === 1 ? 'es' : ''} to inventory
              {floorPoured > 0 ? ', ' : '.'}
            </>
          )}
          {floorPoured > 0 && (
            <>
              {floorReturned > 0 ? 'and the' : 'The'} {floorPoured} unit
              {floorPoured === 1 ? '' : 's'} of media{' '}
              {floorReturned > 0 ? 'are consumed, never returned.' : 'on the floor are consumed, never returned.'}
            </>
          )}
        </RuleNote>
      ) : (
        /* CTL-001 — the close back-flushes the leftover to inventory, so only a
           Super Admin signs it. Producing stays available here. */
        <RuleNote>
          <span className="text-text-2">Produce another batch</span> to make more (the kit stays
          open). Closing the kit back-flushes the {floorTotal} unit
          {floorTotal === 1 ? '' : 's'} still on the floor to inventory, so it is signed by a{' '}
          <span className="text-text-2">Super Admin</span> and recorded.
        </RuleNote>
      )}
    </div>
  );
}

/**
 * A component line's contribution in money (RPT-003).
 *
 * With ``batchQty``, prices the units this pending batch will consume at the
 * line's current unit cost. Without it, reports what the line has already
 * handed to finished lots across every batch.
 *
 * Returns an em dash rather than `$0.00` when the cost is unknown — an input
 * lot with no price. That is not the same as free, and the $0 customer-owned
 * cells are the reason the difference has money behind it.
 */
function lineCost(line: ApiKitLine, batchQty: number | null): string {
  if (batchQty !== null) {
    if (line.unit_cost_amount === null || batchQty <= 0) return '—';
    return formatMoney(String(Number(line.unit_cost_amount) * batchQty));
  }
  return formatMoney(line.consumed_value_amount);
}

/** One labelled figure in the kit strip. */
function ReviewStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-text-3">{label}</div>
      <div className="mt-0.5 text-text-2">{children}</div>
    </div>
  );
}

/**
 * The single component table Review renders.
 *
 * ``mode='batch'`` answers *this batch*: what each component was issued from,
 * what the pending batch uses, what is left on the floor afterwards, and where
 * that leftover goes. ``mode='kit'`` answers the *whole kit*: cumulative used
 * and what is still staged (or was returned, once closed).
 *
 * Two modes rather than two tables — Review used to stack both and the same
 * component appeared twice under different headings, in different frames of
 * reference, which is what made the page unreadable (client 2026-07-28).
 */
/**
 * How much of a line's ``used_qty`` was actually charged to a finished lot.
 *
 * For an ordinary component the two are the same number. For media they part
 * company at close-out: the batches take what the operator recorded, and the
 * remainder is DISCARDED — drained off the floor and charged to no lot
 * (REQ-2026-07-31-KIT-003). Summing the batch consumption rows is what tells
 * them apart after the fact, and the difference is the waste. Derived rather
 * than stored: both numbers are already on the kit and cannot drift apart.
 */
function consumedByLots(kit: ApiKit, lineId: string): number {
  return kit.batches.reduce(
    (a, b) =>
      a +
      b.consumptions
        .filter((c) => c.kit_line_id === lineId)
        .reduce((x, c) => x + c.qty, 0),
    0,
  );
}

function ComponentReviewTable({
  kit,
  mode,
  used,
  returnLoc,
  closed,
}: {
  kit: ApiKit;
  mode: 'batch' | 'kit';
  used: Record<string, number | null>;
  returnLoc: Record<string, string>;
  closed: boolean;
}) {
  const isBatch = mode === 'batch';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-surface/50 text-left text-[10px] uppercase tracking-wider text-text-3">
            <th className="px-4 py-2 font-medium">Component</th>
            <th className="px-4 py-2 font-medium">Issued from</th>
            <th className="px-4 py-2 text-right font-medium">{isBatch ? 'Uses' : 'Used'}</th>
            <th className="px-4 py-2 text-right font-medium">
              {isBatch ? 'Left after' : closed ? 'Back-flushed' : 'On floor'}
            </th>
            {/* RPT-003. The value of what this component contributes — for a
                batch, what it puts into THIS lot; for the kit, what it has
                handed to finished lots in total. */}
            <th className="px-4 py-2 text-right font-medium">Cost</th>
            <th className="px-4 py-2 font-medium">
              {closed ? 'Returned to' : 'Back-flushes to'}
            </th>
          </tr>
        </thead>
        <tbody>
          {kit.lines.map((line) => {
            const thisBatch = used[line.id] ?? 0;
            const leftAfter = line.on_floor_qty - thisBatch;
            const remaining = isBatch ? leftAfter : line.on_floor_qty;
            // KIT-003: closing the kit DISCARDS a media line's leftover — it is
            // drained off the floor and never returned to stock, but it is not
            // charged to this batch's lot either (client, 2026-09-01). The lot
            // pays for what the batch recorded; the rest is waste against the
            // kit. So this annotates the quantity only — deliberately not the
            // cost, because the cost does not move.
            const discardedAtClose = isBatch && line.consumed_in_kit ? leftAfter : 0;
            // After the fact: what this line was recorded as using, minus what
            // the batches actually charged to lots. Non-zero only for media —
            // EXCEPT on a kit with no batch rows at all (produced before cost
            // tracking), where it is the whole line and nothing was discarded.
            // See ``neverCosted`` above: the difference is waste versus a
            // missing record, and only one of them is the operator's problem.
            const discardedTotal = Math.max(
              0,
              (line.used_qty ?? 0) - consumedByLots(kit, line.id),
            );
            const leftoverWord = kit.batches.length === 0 ? 'never costed' : 'discarded';
            return (
              <tr key={line.id} className="border-b border-border/60 align-top last:border-0">
                <td className="max-w-[240px] px-4 py-2.5">
                  <ItemCell
                    itemNumber={line.item_number}
                    description={line.description}
                    itemId={line.item_id}
                  />
                </td>
                <td className="px-4 py-2.5">
                  {line.issued_from.length ? (
                    <div className="flex flex-wrap gap-1">
                      {line.issued_from.map((f, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center gap-1 rounded border border-border bg-surface/60 px-1.5 py-0.5 text-[11px]"
                          title={f.location}
                        >
                          <span className="font-mono text-text">{f.lot_number ?? 'No lot'}</span>
                          <span className="font-mono tabular-nums text-text-2">×{f.qty}</span>
                          {/* The per-lot price (RPT-003). A line drawing from
                              two lots reports a blended unit cost, and these
                              are what it blends — without them the average is
                              a number nobody can check. */}
                          <span
                            className="font-mono tabular-nums text-text-3"
                            title={
                              f.unit_price_amount === null
                                ? 'This lot has no price, so the line has no cost'
                                : 'Price per unit'
                            }
                          >
                            @ {formatMoney(f.unit_price_amount)}
                          </span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-text-3">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <QtyCell value={isBatch ? thisBatch || null : (line.used_qty ?? null)} />
                  {!isBatch && discardedTotal > 0 && (
                    <div className="text-[11px] text-text-3">
                      {(line.used_qty ?? 0) - discardedTotal} to lots · {discardedTotal}{' '}
                      {leftoverWord}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <QtyCell value={remaining || null} tone={remaining ? 'success' : 'muted'} />
                  {discardedAtClose > 0 && (
                    <div className="text-[11px] text-text-3">discarded at close</div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="font-mono text-xs tabular-nums text-text-2">
                    {lineCost(line, isBatch ? thisBatch : null)}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-xs text-text-2">
                    {line.consumed_in_kit ? (
                      // KIT-003: media is poured at sign-out, never returned, so
                      // it has no destination HOWEVER much is still on the floor.
                      // This test has to come before the `remaining > 0` one —
                      // behind it, a media line with a leftover fell through to
                      // the LocationPath and advertised a back-flush that is
                      // never going to happen (user, 2026-09-01).
                      closed
                        ? discardedTotal > 0
                          ? `Consumed · ${discardedTotal} discarded`
                          : 'Consumed'
                        : discardedAtClose > 0
                          ? `Discarded at close (${discardedAtClose})`
                          : 'Consumed at close'
                    ) : remaining > 0 ? (
                      <LocationPath
                        nodeId={closed ? line.return_location_node_id : returnLoc[line.id]}
                      />
                    ) : (
                      '—'
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Additional issue dialog ─────────────────────────────────────────────────

function AdditionalIssueDialog({
  kit,
  line,
  onOpenChange,
  onDone,
}: {
  kit: ApiKit;
  line: ApiKitLine | null;
  onOpenChange: (open: boolean) => void;
  onDone: (kit: ApiKit) => void;
}) {
  const [picks, setPicks] = React.useState<LotPick[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!line) return;
    // Start with one blank row — the operator adds lots/quantities directly.
    setPicks(line.source_lots.length ? autoFillFifo(line.source_lots, 0) : []);
  }, [line?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!line) return null;

  const issuedSoFar = lineIssuedTotal(line);
  const totalAvail = line.source_lots.reduce((a, l) => a + l.qty, 0);
  const adding = picksTotal(picks);
  const ready = adding > 0 && picksValid(line.source_lots, picks);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const k = await kitsApi.additionalIssue(kit.id, line.id, {
        sources: picksToSources(picks),
      });
      toast.success('Additional material issued', {
        description: `${adding} × ${line.item_number}.`,
      });
      onDone(k);
    } catch (err) {
      toast.error('Could not issue', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={line !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Issue more to {kit.kit_number}</DialogTitle>
          <DialogDescription>
            Production needed extra material. Draw it from any lots or shelves — this posts as a
            separate additional issue and adds to what&apos;s on the floor.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {/* Component + at-a-glance numbers. */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-surface/50 p-3">
            <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
            <div className="flex items-center gap-5 text-center">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-text-3">Issued</div>
                <div className="font-mono text-sm text-text">{issuedSoFar}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-text-3">In stock</div>
                <div className={cn('font-mono text-sm', totalAvail <= 0 ? 'text-danger' : 'text-text')}>
                  {totalAvail}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-text-3">Adding</div>
                <div className="font-mono text-sm font-semibold text-accent">{adding}</div>
              </div>
            </div>
          </div>

          <LotSourcePicker
            itemNumber={line.item_number}
            lots={line.source_lots}
            needed={0}
            picks={picks}
            onChange={setPicks}
            disabled={busy}
            modal
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !ready}>
            <PackagePlus size={14} /> Issue {adding}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Return excess dialog (REQ-2026-07-01-TRX-008) ───────────────────────────

function ReturnExcessDialog({
  kit,
  line,
  returnAllowedIds,
  onOpenChange,
  onDone,
}: {
  kit: ApiKit;
  line: ApiKitLine | null;
  returnAllowedIds: Set<string>;
  onOpenChange: (open: boolean) => void;
  onDone: (kit: ApiKit) => void;
}) {
  const floorLots = React.useMemo(() => line?.on_floor_lots ?? [], [line?.on_floor_lots]);
  const [rows, setRows] = React.useState<ReturnRow[]>([]);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!line) return;
    const first = line.on_floor_lots[0];
    const node = line.return_location_node_id ?? line.source_location_node_id ?? '';
    // Start on the earliest-expiry floor lot, its full qty pre-filled — the
    // operator adjusts or splits with "Add another lot".
    setRows([
      { key: 'ret-0', lot_id: first?.lot_id ?? '', node, isBox: false, cells: [], qty: first?.qty ?? null },
    ]);
    setReason('');
  }, [line?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!line) return null;

  const onFloor = line.on_floor_qty;
  const lotAvail = (lotId: string) => floorLots.find((l) => l.lot_id === lotId)?.qty ?? 0;
  const rowEff = (r: ReturnRow) => (r.isBox ? r.cells.length : r.qty ?? 0);
  // This row's cap is the LOWER of two limits, and both are needed:
  //
  //   * its lot's on-floor qty, minus what other rows already take from the
  //     SAME lot — a lot can be split across more than one destination;
  //   * what THIS KIT still holds, minus what every other row takes — because
  //     the kit's on-floor total is the real ceiling, and with two lots each
  //     capped at that total the rows could otherwise sum past it and the
  //     return would be refused (``return_exceeds_on_floor``) only on submit.
  const rowCap = (r: ReturnRow) => {
    const sameLot = rows
      .filter((x) => x.key !== r.key && x.lot_id === r.lot_id)
      .reduce((s, x) => s + rowEff(x), 0);
    const anyRow = rows.filter((x) => x.key !== r.key).reduce((s, x) => s + rowEff(x), 0);
    return Math.max(0, Math.min(lotAvail(r.lot_id) - sameLot, onFloor - anyRow));
  };
  const setRow = (key: string, patch: Partial<ReturnRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /** Cells the OTHER rows already claim in the box ``r`` is returning to. Two
   *  rows may return to one box (two lots, or one lot split) but never to the
   *  same physical position; nothing on the server knows about a claim until
   *  this is submitted. The same guard close-out (``reservedFor``) and the
   *  transfer dialog already apply. */
  const reservedFor = (r: ReturnRow) =>
    new Set(
      rows
        .filter((x) => x.key !== r.key && x.isBox && x.node === r.node)
        .flatMap((x) => x.cells),
    );

  const totalReturn = rows.reduce((s, r) => s + rowEff(r), 0);
  const ready =
    rows.length > 0 &&
    rows.every((r) => r.lot_id && r.node && rowEff(r) > 0 && rowEff(r) <= rowCap(r));

  // The next earliest-expiry floor lot not yet used by a row (for "Add another").
  const nextLot = floorLots.find((l) => !rows.some((r) => r.lot_id === l.lot_id));

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const k = await kitsApi.returnExcess(kit.id, line.id, {
        sources: rows.map((r) => ({
          lot_id: r.lot_id,
          qty: rowEff(r),
          return_location_node_id: r.node,
          return_cells: r.isBox ? r.cells.map(toCell) : undefined,
        })),
        reason: reason.trim() || null,
      });
      toast.success('Returned to inventory', {
        description: `${totalReturn} × ${line.item_number} back in stock.`,
      });
      onDone(k);
    } catch (err) {
      toast.error('Could not return', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={line !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Return excess from {kit.kit_number}</DialogTitle>
          <DialogDescription>
            Hand unused material back to inventory without closing the kit. Pick which
            on-floor lot to return and where — each unit goes back on its own lot, so it is
            never stranded.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="rounded-md border border-border bg-surface p-3">
            <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
          </div>
          <dl className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded-md border border-border bg-bg-elev p-2" title="Everything here can be returned">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">On floor</dt>
              <dd
                className={cn('mt-0.5 font-mono text-sm', onFloor <= 0 ? 'text-danger' : 'text-text')}
              >
                {onFloor}
              </dd>
            </div>
            <div className="rounded-md border border-border bg-bg-elev p-2">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">Already returned</dt>
              <dd className="mt-0.5 font-mono text-sm text-text">{line.early_returned_qty}</dd>
            </div>
          </dl>

          {floorLots.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-text-3">
              Nothing on the floor to return.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-text-2">Return from lot</label>
                <span className="font-mono text-[11px] text-text-3">{totalReturn} returning</span>
              </div>
              {rows.map((r, i) => {
                const cap = rowCap(r);
                return (
                  <div key={r.key} className="rounded-lg border border-border bg-surface/40 p-3">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1 space-y-2">
                        {/* Which on-floor lot's units to return. */}
                        <Select
                          value={r.lot_id}
                          onValueChange={(v) => setRow(r.key, { lot_id: v })}
                        >
                          <SelectTrigger aria-label={`Return lot ${i + 1}`} className="h-8">
                            <SelectValue placeholder="Pick a lot" />
                          </SelectTrigger>
                          <SelectContent>
                            {floorLots.map((l) => (
                              <SelectItem key={l.lot_id} value={l.lot_id}>
                                {l.lot_number ?? '—'} · {l.qty} on floor
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {/* Where it goes back to. */}
                        <LocationTreePicker
                          aria-label={`Return location ${i + 1}`}
                          value={r.node}
                          onChange={(v) => setRow(r.key, { node: v, isBox: false, cells: [] })}
                          areas={['storage']}
                          allowedNodeIds={returnAllowedIds}
                          modal
                          showPath
                        />
                        {r.node && (
                          <>
                            {/* Box → pick exact cells (qty follows); bulk → typed qty. */}
                            <BoxCellPicker
                              nodeId={r.node}
                              qty={cap}
                              value={r.cells}
                              onChange={(cells) => setRow(r.key, { cells })}
                              onResolved={(isBox) => {
                                if (isBox !== r.isBox) setRow(r.key, { isBox, cells: [], qty: isBox ? null : cap });
                              }}
                              reserved={reservedFor(r)}
                              derive
                            />
                            {!r.isBox && (
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-text-3">Quantity</span>
                                <NumberInput
                                  aria-label={`Return quantity ${i + 1}`}
                                  value={r.qty}
                                  min={1}
                                  invalid={rowEff(r) > cap}
                                  onChange={(v) => setRow(r.key, { qty: v == null ? null : Math.min(v, cap) })}
                                  className="h-8 w-24"
                                />
                                <span className="text-[11px] text-text-3">of {cap} left</span>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      {rows.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                          aria-label="Remove this lot"
                          className="mt-1 grid size-8 shrink-0 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-2 hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {nextLot && (
                <button
                  type="button"
                  onClick={() =>
                    setRows((rs) => [
                      ...rs,
                      {
                        key: `ret-${rs.length}-${nextLot.lot_id}`,
                        lot_id: nextLot.lot_id,
                        node: line.return_location_node_id ?? line.source_location_node_id ?? '',
                        isBox: false,
                        cells: [],
                        qty: nextLot.qty,
                      },
                    ])
                  }
                  className="flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
                >
                  <Plus size={13} /> Add another lot
                </button>
              )}
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">
              Reason <span className="text-text-3">(optional)</span>
            </label>
            <Input
              aria-label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Over-pulled at staging"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !ready}>
            Return {totalReturn}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One row in the Return dialog: which on-floor lot to return, how many, and
 *  the destination location (with box cells when the target is an LN2 box). */
interface ReturnRow {
  key: string;
  lot_id: string;
  node: string;
  isBox: boolean;
  cells: string[];
  qty: number | null;
}

// ── Cancel dialog (per-line returns, D1) ────────────────────────────────────

function CancelKitDialog({
  kit,
  open,
  returnAllowedIds,
  onOpenChange,
  onSubmit,
}: {
  kit: ApiKit;
  open: boolean;
  returnAllowedIds: Set<string>;
  onOpenChange: (open: boolean) => void;
  /** Hand the chosen return locations back — the parent then collects the
   *  signature and posts the cancel. */
  onSubmit: (lines: CancelLineInput[]) => void;
}) {
  const lines = React.useMemo(() => kit.lines.filter((l) => l.on_floor_qty > 0), [kit.lines]);
  // KIT-003 splits what a cancel does with the floor, so this dialog has to
  // split too: ordinary components go back to inventory and need a destination,
  // media is DISCARDED and has none. Offering it a location picker asked the
  // operator to decide something the server ignores, then counted those units in
  // "return 20 & sign" — a promise the cancel does not keep (user, 2026-09-01).
  const returning = React.useMemo(() => lines.filter((l) => !l.consumed_in_kit), [lines]);
  const discarding = React.useMemo(() => lines.filter((l) => l.consumed_in_kit), [lines]);

  // Default each line to where it was pulled from (D1).
  React.useEffect(() => {
    if (!open) return;
    // One row per line, pre-set to where the material was pulled from — the
    // common case is still a single location, and "Add another location" only
    // appears once some of the quantity is still unplaced.
    setDests(
      Object.fromEntries(
        lines.map((l) => [
          l.id,
          [
            {
              ...emptyDest(),
              location_node_id:
                l.return_location_node_id ?? l.source_location_node_id ?? '',
              qty: l.on_floor_qty,
            },
          ],
        ]),
      ),
    );
  }, [open, lines]);

  // A line's material may be SPLIT across locations (client 2026-07-30) when no
  // single box has enough free cells — the same shape the produced output has
  // used since 2026-07-23, so there is one pattern for "put these units in more
  // than one place".
  const [dests, setDests] = React.useState<Record<string, OutputDest[]>>({});
  const destsFor = (lineId: string): OutputDest[] => dests[lineId] ?? [];

  const ready = returning.every(
    (l) => destsFor(l.id).reduce((s, d) => s + destPlaced(d), 0) === l.on_floor_qty,
  );
  const returnUnits = returning.reduce((a, l) => a + l.on_floor_qty, 0);
  const discardUnits = discarding.reduce((a, l) => a + l.on_floor_qty, 0);

  const submit = () => {
    if (!ready) return;
    onSubmit(
      // Media carries no destinations — the server exempts it from the
      // every-line-needs-one check and would ignore them anyway.
      returning.map((l) => ({
        line_id: l.id,
        destinations: destsFor(l.id).map((d) => ({
          location_node_id: d.location_node_id,
          qty: destPlaced(d),
          return_cells: d.isBox ? d.cells.map(toCell) : undefined,
        })),
      })),
    );
  };

  // Cells another row in this same dialog has already taken, per box — across
  // every line AND every split row within a line. A cell holds exactly one unit,
  // so two components returning into the same box cannot both claim A1, and each
  // picker only knew its own selection, so the dialog happily built a request the
  // database would refuse. The close-out dialog has always reserved across its
  // rows; this one did not.
  const claimedByNode = new Map<string, Set<string>>();
  lines.forEach((l) =>
    destsFor(l.id).forEach((d) => {
      if (!d.location_node_id || !d.isBox) return;
      const taken = claimedByNode.get(d.location_node_id) ?? new Set<string>();
      d.cells.forEach((c) => taken.add(c));
      claimedByNode.set(d.location_node_id, taken);
    }),
  );
  /** Everything claimed on ``nodeId`` except this row's own picks. */
  const reservedFor = (nodeId: string | undefined, own: string[]): Set<string> => {
    const all = nodeId ? claimedByNode.get(nodeId) : undefined;
    if (!all) return new Set();
    const ownSet = new Set(own);
    return new Set([...all].filter((k) => !ownSet.has(k)));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cancel {kit.kit_number}?</DialogTitle>
          <DialogDescription>
            {returnUnits > 0 && (
              <>
                {returnUnits} unit{returnUnits === 1 ? '' : 's'} still on the production floor
                will be returned to inventory as a back-flush. Choose where each component goes —
                each is pre-set to where it was pulled from.{' '}
              </>
            )}
            {discardUnits > 0 && (
              <>
                {discardUnits} unit{discardUnits === 1 ? '' : 's'} of media {discardUnits === 1 ? 'is' : 'are'}{' '}
                <span className="text-text-2">discarded</span> — media is never returned to
                inventory.{' '}
              </>
            )}
            You’ll sign to confirm on the next step.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[55vh] space-y-3 overflow-y-auto">
          {returning.map((line) => {
            const rows = destsFor(line.id);
            const placed = rows.reduce((s, d) => s + destPlaced(d), 0);
            return (
              <div key={line.id} className="rounded-md border border-border bg-surface p-3">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
                  <span
                    className={cn(
                      'shrink-0 font-mono text-sm tabular-nums',
                      placed === line.on_floor_qty ? 'text-success' : 'text-text',
                    )}
                  >
                    {placed} / {line.on_floor_qty}
                  </span>
                </div>
                <OutputPlacement
                  good={line.on_floor_qty}
                  dests={rows}
                  onChange={(next) => setDests((p) => ({ ...p, [line.id]: next }))}
                  allowedIds={returnAllowedIds}
                  required
                  reservedFor={reservedFor}
                  label={`Return ${line.item_number} to`}
                  noun={`Return location for ${line.item_number}`}
                  hideHeader
                />
              </div>
            );
          })}
          {discarding.map((line) => (
            <div
              key={line.id}
              className="rounded-md border border-dashed border-border bg-surface/40 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <ItemCell
                  itemNumber={line.item_number}
                  description={line.description}
                  itemId={line.item_id}
                />
                <span className="shrink-0 font-mono text-sm tabular-nums text-text-3">
                  {line.on_floor_qty} discarded
                </span>
              </div>
              <p className="mt-2 text-xs text-text-3">
                Consumed to the kit, so there is nowhere to return it — these units are written
                off when the kit is cancelled.
              </p>
            </div>
          ))}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep kit
          </Button>
          <Button variant="danger" onClick={submit} disabled={!ready}>
            {returnUnits > 0
              ? `Continue — return ${returnUnits} & sign`
              : 'Continue — discard & sign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Activity timeline ───────────────────────────────────────────────────────

/** Visual config per kitting operation — the timeline dot's icon + colour. */
const OP_TIMELINE: Record<string, { label: string; Icon: LucideIcon; tone: string }> = {
  create: { label: 'Kit created', Icon: PackagePlus, tone: 'accent' },
  edit_line: { label: 'Draft edited', Icon: Pencil, tone: 'neutral' },
  issue: { label: 'Issued to production', Icon: Send, tone: 'accent' },
  additional_issue: { label: 'Additional issue', Icon: Plus, tone: 'warning' },
  early_return: { label: 'Excess returned', Icon: Undo2, tone: 'success' },
  production_draft: { label: 'Production recorded', Icon: FlaskConical, tone: 'neutral' },
  close_out: { label: 'Closed out', Icon: CheckCircle2, tone: 'success' },
  cancel: { label: 'Cancelled', Icon: XCircle, tone: 'danger' },
};

/** Fallback op for a movement with no matching audit event (legacy kits). */
const MTYPE_OP: Record<string, string> = {
  kit_issue: 'issue',
  kit_additional_issue: 'additional_issue',
  kit_return: 'early_return',
  backflush: 'close_out',
  production_output: 'close_out',
  kit_cancel_return: 'cancel',
};

const TONE_DOT: Record<string, string> = {
  accent: 'border-accent/40 bg-accent-soft text-accent',
  success: 'border-success/40 bg-success-soft text-success',
  warning: 'border-warning/45 bg-warning-soft text-warning',
  danger: 'border-danger/40 bg-danger-soft text-danger',
  neutral: 'border-border-strong bg-bg-elev text-text-2',
};

interface TimelineNode {
  key: string;
  time: string;
  operation: string;
  goodQty: number | null;
  scrapQty: number | null;
  outputLocation: string | null;
  outputExpiry: string | null;
  /** Material this batch consumed (produce / close) — no stock movement backs it. */
  consumed: ApiKitAuditEvent['consumed'];
  moves: ApiKitActivityRow[];
}

/** REQ-2026-07-31-KIT-002 — the campaign day an event happened on.
 *
 *  The client's own picture of a multi-day kit is a tree of ISSUE EVENTS by day
 *  (day 0, 5, 12, 18 …), not a partition of the recipe: the same material comes
 *  out again whenever the campaign calls for it, so "media" legitimately appears
 *  under day 0, day 12 AND day 18. That shape can only be read off the ledger —
 *  a label stored per material could never express it, since a material has no
 *  single day.
 *
 *  So nothing here is stored. The rows are the ``kit_issue`` /
 *  ``kit_additional_issue`` movements the system already writes, grouped by the
 *  day they were performed. That is what the requirement means by "a
 *  naming/organization layer over the existing issue logic, not new consumption
 *  logic" — this file computes headings and nothing else.
 */

/** Local calendar day of a timestamp, as a stable YYYY-MM-DD key.
 *
 *  Deliberately LOCAL rather than the ISO string's UTC date: the day an operator
 *  means is the day they were standing in the suite, and a late-evening pull
 *  would otherwise be filed under tomorrow. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** Midnight-to-midnight days between two timestamps, so "day 5" means the fifth
 *  calendar day of the campaign rather than 120-odd hours. */
function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso);
  const b = new Date(toIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.max(0, Math.round((midnight(b) - midnight(a)) / 86_400_000));
}

function formatDayDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
  });
}

/** A date rule between one campaign day and the next.
 *
 *  Day 0 is the day material was FIRST ISSUED, not the day the kit record was
 *  created — a kit may be drafted a week before anyone reaches the bench, and
 *  numbering from the draft would put the campaign's first day at "day 7". */
function TimelineDayHeading({ dayIndex, time }: { dayIndex: number; time: string }) {
  return (
    <li className="flex items-center gap-3 pb-3 pt-1 first:pt-0">
      <span className="text-[11px] font-medium uppercase tracking-wider text-text-2">
        Day {dayIndex}
      </span>
      <span className="text-[11px] text-text-3">{formatDayDate(time)}</span>
      <span className="h-px flex-1 bg-border" />
    </li>
  );
}

/** Fold the audit events + stock movements into one chronological timeline.
 *  Every movement shares its transaction's timestamp with the event that caused
 *  it (both use the DB's transaction clock), so we attach movements to events by
 *  equal time; any orphan movements (legacy kits with no events) become their
 *  own nodes. */
function buildTimeline(events: ApiKitAuditEvent[], moves: ApiKitActivityRow[]): TimelineNode[] {
  const byTime = new Map<number, ApiKitActivityRow[]>();
  for (const m of moves) {
    const t = new Date(m.performed_at).getTime();
    const bucket = byTime.get(t);
    if (bucket) bucket.push(m);
    else byTime.set(t, [m]);
  }

  const nodes: TimelineNode[] = [];
  const consumed = new Set<number>();
  for (const ev of events) {
    const t = new Date(ev.occurred_at).getTime();
    consumed.add(t);
    nodes.push({
      key: ev.id,
      time: ev.occurred_at,
      operation: ev.operation,
      goodQty: ev.good_qty,
      scrapQty: ev.scrap_qty,
      outputLocation: ev.output_location,
      outputExpiry: ev.output_expiration_date,
      consumed: ev.consumed ?? [],
      moves: byTime.get(t) ?? [],
    });
  }
  // Orphan movement groups (no event) — keep them visible rather than dropping.
  for (const [t, group] of byTime) {
    const first = group[0];
    if (consumed.has(t) || !first) continue;
    nodes.push({
      key: `mv-${t}`,
      time: first.performed_at,
      operation: MTYPE_OP[first.movement_type] ?? 'issue',
      goodQty: null,
      scrapQty: null,
      outputLocation: null,
      outputExpiry: null,
      consumed: [],
      moves: group,
    });
  }
  // Oldest → newest: the kit's story reads top to bottom.
  nodes.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  return nodes;
}

function ActivitySheet({
  kitId,
  kitNumber,
  open,
  onOpenChange,
}: {
  kitId: string;
  kitNumber: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [rows, setRows] = React.useState<ApiKitActivityRow[] | null>(null);
  const [events, setEvents] = React.useState<ApiKitAuditEvent[]>([]);

  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setRows(null);
    setEvents([]);
    void kitsApi
      .activity(kitId, { signal: ctrl.signal })
      .then((r) => {
        setRows(r.items);
        setEvents(r.events ?? []);
      })
      .catch(() => setRows([]));
    return () => ctrl.abort();
  }, [open, kitId]);

  const timeline = React.useMemo(
    () => (rows ? buildTimeline(events, rows) : []),
    [events, rows],
  );

  /** Day 0 of the campaign — the first node that actually MOVED material.
   *  Falls back to the first node at all, so a kit that has only been created
   *  still numbers from something rather than crashing. */
  const day0 = React.useMemo(() => {
    const firstIssue = timeline.find((n) =>
      n.moves.some(
        (m) => m.movement_type === 'kit_issue' || m.movement_type === 'kit_additional_issue',
      ),
    );
    return (firstIssue ?? timeline[0])?.time ?? null;
  }, [timeline]);

  // Headings show from the first day, not only once a kit turns out to span
  // several. A campaign is only "multi-day" in hindsight: suppressing the
  // heading until day 2 means the structure appears days after the operator
  // started working to it, and on day 0 the feature looks absent. One line
  // reading "Day 0" is orientation, not noise — the client's own picture of a
  // campaign starts at Day 0 with a single day on it.

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:w-[640px]">
        <SheetHeader>
          <SheetTitle>Activity — {kitNumber}</SheetTitle>
          <p className="text-xs text-text-3">
            The kit’s full story, oldest first. Each step shows what happened and the exact stock it
            moved. Steps are grouped by intervention day, counted from the day material was first
            issued — so a campaign that runs over several days reads day by day.
          </p>
        </SheetHeader>
        <SheetBody className="px-0 py-0">
          {rows === null ? (
            <p className="p-6 text-center text-xs text-text-3">Loading…</p>
          ) : timeline.length === 0 ? (
            <div className="p-6">
              <EmptyState title="Nothing yet" hint="Issuing the kit writes the first step." />
            </div>
          ) : (
            <ol className="px-5 py-4">
              {timeline.map((node, i) => {
                // A heading whenever the calendar day changes — including on the
                // first node, so the campaign opens with "Day 0" rather than
                // starting mid-air.
                const prev = i > 0 ? timeline[i - 1] : undefined;
                const newDay = !prev || dayKey(prev.time) !== dayKey(node.time);
                return (
                  <React.Fragment key={node.key}>
                    {newDay && day0 && (
                      <TimelineDayHeading
                        dayIndex={daysBetween(day0, node.time)}
                        time={node.time}
                      />
                    )}
                    <TimelineItem node={node} last={i === timeline.length - 1} />
                  </React.Fragment>
                );
              })}
            </ol>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function TimelineItem({ node, last }: { node: TimelineNode; last: boolean }) {
  const cfg = OP_TIMELINE[node.operation] ?? {
    label: node.operation,
    Icon: ScrollText,
    tone: 'neutral',
  };
  const { Icon } = cfg;
  const showYield =
    (node.operation === 'close_out' || node.operation === 'production_draft') &&
    (node.goodQty !== null || node.scrapQty !== null);

  return (
    <li className="relative flex gap-3.5 pb-5 last:pb-0">
      {/* Rail: connecting line behind the dot, drawn except on the last node. */}
      {!last && (
        <span
          aria-hidden
          className="absolute left-[15px] top-8 bottom-0 w-px bg-border"
        />
      )}
      <span
        className={cn(
          'relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border',
          TONE_DOT[cfg.tone] ?? TONE_DOT.neutral,
        )}
      >
        <Icon size={15} />
      </span>

      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h3 className="text-sm font-medium text-text">{cfg.label}</h3>
          <time className="whitespace-nowrap text-[11px] tabular-nums text-text-3">
            {formatDateTime(node.time)}
          </time>
        </div>

        {showYield && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge tone="success">{node.goodQty ?? 0} good</Badge>
            {(node.scrapQty ?? 0) > 0 && <Badge tone="danger">{node.scrapQty} scrapped</Badge>}
          </div>
        )}

        {(node.outputLocation || node.outputExpiry) && (
          <dl className="mt-1.5 space-y-0.5 text-[11px]">
            {node.outputLocation && (
              <div className="flex gap-1.5">
                <dt className="text-text-3">Stocked to</dt>
                <dd className="min-w-0 font-medium text-text-2">
                  <LocationPath path={node.outputLocation} />
                </dd>
              </div>
            )}
            {node.outputExpiry && (
              <div className="flex gap-1.5">
                <dt className="text-text-3">Expires</dt>
                <dd className="font-medium text-text-2">{node.outputExpiry}</dd>
              </div>
            )}
          </dl>
        )}

        {node.consumed.length > 0 && (
          <div className="mt-2">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-3">
              Consumed this batch
            </p>
            <ul className="space-y-1.5">
              {node.consumed.map((c) => (
                <li
                  key={c.item_id}
                  className="flex items-center gap-2 rounded-md border border-border/70 bg-bg-elev px-2.5 py-1.5"
                >
                  <span className="w-11 shrink-0 text-right font-mono text-xs font-semibold tabular-nums text-danger">
                    −{c.qty}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-text-2">{c.item_number}</span>
                  <span className="truncate text-[11px] text-text-3">used to build</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Split the step's stock moves into self-describing sub-sections
            (client 2026-07-24): the produced output ("Made") and the leftover
            returns ("Back-flushed") — mirroring the "Consumed this batch"
            section — instead of one flat, mixed list. Issue rows have no
            category here, so they render plainly under their own step. */}
        {(() => {
          const made = node.moves.filter((m) => m.movement_type === 'production_output');
          // Only the CLOSE-OUT reconciliation is a "back-flush". A mid-production
          // return (kit_return) or a cancel return (kit_cancel_return) is NOT —
          // those render plainly under their own step ("Excess returned" /
          // "Cancelled"), whose title already says what happened.
          const backflushed = node.moves.filter((m) => m.movement_type === 'backflush');
          const plain = node.moves.filter(
            (m) => m.movement_type !== 'production_output' && m.movement_type !== 'backflush',
          );
          return (
            <>
              <MoveList moves={plain} />
              <MoveList title="Made" moves={made} />
              <MoveList title="Back-flushed" moves={backflushed} />
            </>
          );
        })()}
      </div>
    </li>
  );
}

/** One labelled block of stock moves in a timeline step. Without a title it
 *  renders the moves plainly (e.g. issue rows under their own step); with one
 *  it's a sub-section ("Made" / "Back-flushed") like "Consumed this batch". */
function MoveList({ title, moves }: { title?: string; moves: ApiKitActivityRow[] }) {
  if (moves.length === 0) return null;
  return (
    <div className="mt-2">
      {title && (
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-3">{title}</p>
      )}
      <ul className="space-y-1.5">
        {moves.map((m) => (
          <li
            key={m.id}
            className="flex items-center gap-2 rounded-md border border-border/70 bg-bg-elev px-2.5 py-1.5"
          >
            <span
              className={cn(
                'w-11 shrink-0 text-right font-mono text-xs font-semibold tabular-nums',
                m.qty_delta > 0 ? 'text-success' : 'text-danger',
              )}
            >
              {m.qty_delta > 0 ? `+${m.qty_delta}` : m.qty_delta}
            </span>
            <span className="shrink-0 font-mono text-xs text-text-2">{m.item_number}</span>
            <span className="truncate text-[11px] text-text-3" title={m.notes ?? undefined}>
              {m.notes}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
