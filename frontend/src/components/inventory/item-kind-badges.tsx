'use client';

import { FlaskConical, Recycle, Sprout } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * How an item behaves when it is consumed — the two flags, as badges.
 *
 * One component rather than a tone-and-label decision at each call site, for the
 * same reason `StockStatusBadge` exists: the item list, the item header and the
 * kit screens must not describe the same item three different ways. Anything
 * that needs these badges imports them; nothing picks its own wording.
 *
 * The distinction is easy to get wrong and expensive when it is, so both badges
 * carry the rule in a tooltip:
 *
 *   * **Consumable** — blind-consumed with no per-lot traceability
 *     (REQ-2026-07-01-TRX-003), and barred from bills of material entirely
 *     (Transaction Spec §4.3). It can never be a kit component.
 *   * **Consumed in kits** — the non-consumable TWIN of a consumable
 *     (REQ-2026-07-31-KIT-003, client 2026-08-31). An ordinary tracked item that
 *     may sit in a BOM, but which no route ever returns to stock: whatever a
 *     kit does not use is discarded when it closes.
 *
 * The two are mutually exclusive, enforced by
 * `ck_items_consumable_xor_consumed_in_kit`.
 *
 * `VariableYieldBadge` lives here too, though it is a different kind of fact —
 * about how an item is MADE rather than how it is consumed — because the reason
 * for a shared module is the same: it appears on the item list, the item header
 * and the kit screens, and those must not word it three ways.
 */

/** The consumable classification. Only meaningful on raw materials — a built
 *  item is manufactured, never blind-consumed — so callers on AY/FG omit it. */
export function ConsumableBadge({ isConsumable }: { isConsumable: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge tone={isConsumable ? 'warning' : 'neutral'}>
          {isConsumable ? (
            <>
              <Recycle size={11} aria-hidden /> Consumable
            </>
          ) : (
            'Non-consumable'
          )}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {isConsumable
          ? 'Blind-consumed. Never in a bill of materials.'
          : 'Lot-tracked. Can be a kit component.'}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The media twin. Renders nothing unless the flag is set, so callers can drop
 * it in unconditionally rather than repeating the condition.
 */
export function ConsumedInKitBadge({ consumedInKit }: { consumedInKit: boolean }) {
  if (!consumedInKit) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge tone="accent">
          <FlaskConical size={11} aria-hidden /> Consumed in kits
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Never returned to stock — the leftover is discarded at close.
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Grown or expressed rather than assembled (client 2026-09-01). Renders nothing
 * unless the flag is set, like the badge above.
 *
 * Only meaningful on a built tier — it describes what a kit for this item is
 * allowed to yield — but the flag can only be set there in the first place, so
 * callers need no extra condition.
 */
export function VariableYieldBadge({ variableYield }: { variableYield: boolean }) {
  if (!variableYield) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge tone="accent">
          <Sprout size={11} aria-hidden /> Variable yield
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Grown, not assembled — the recipe doesn&apos;t limit how much a batch can make.
      </TooltipContent>
    </Tooltip>
  );
}
