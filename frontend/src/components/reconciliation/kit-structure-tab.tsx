'use client';

import * as React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { ExpiryBadge, ItemCell, QtyCell, RuleNote, Stat } from './recon-bits';
import { bomTree, hasBom, itemOf, onHandTotal, type BomNode, type Kit } from './reconciliation-data';
import { useReconStore } from './reconciliation-store';

/**
 * Kit structure — the exploded BOM with availability read at every level
 * (TechReq v2 §6). A child sub-assembly shows its own recipe read-only: this
 * kit consumes AY *stock*, it does not explode the AY's BOM, because an AY is
 * built by its own earlier kit (Transaction Spec §3.1).
 */
export function KitStructureTab({ kit }: { kit: Kit }) {
  const stock = useReconStore((s) => s.stock);
  const parent = itemOf(kit.parentItemId);

  const shortLines = kit.lines.filter((l) => onHandTotal(stock, l.itemId) < l.qtyNeeded);
  const consumableLines = kit.lines.filter((l) => l.isConsumable);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Building" value={`${kit.buildQty} × ${parent.id}`} hint={parent.desc} />
        <Stat label="BOM lines" value={kit.lines.length} hint={`${consumableLines.length} consumable`} />
        <Stat
          label="Short lines"
          value={shortLines.length}
          tone={shortLines.length > 0 ? 'danger' : 'success'}
          hint={shortLines.length ? 'Not enough on hand to cover Needed' : 'Every line is covered'}
        />
        <Stat label="Production location" value={kit.productionLocation} hint="Issued material lands here" />
      </div>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Bill of materials</h2>
          <p className="mt-0.5 text-xs text-text-3">
            Quantity Needed is <span className="font-mono">per-unit × {kit.buildQty}</span>, straight
            from the BOM. Expand a sub-assembly to see what it is made of.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                <th className="w-8 px-2 py-2" />
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Per unit</th>
                <th className="px-3 py-2 text-right font-medium">Needed</th>
                <th className="px-3 py-2 text-right font-medium">On hand</th>
                <th className="px-3 py-2 font-medium">Storage</th>
                <th className="px-3 py-2 font-medium">Expiry</th>
                <th className="px-3 py-2 font-medium">Availability</th>
              </tr>
            </thead>
            <tbody>
              {kit.lines.map((line) => (
                <BomRow
                  key={line.itemId}
                  itemId={line.itemId}
                  qtyPerUnit={line.qtyPerUnit}
                  qtyNeeded={line.qtyNeeded}
                  depth={0}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {shortLines.length > 0 && (
        <RuleNote>
          {shortLines.some((l) => itemOf(l.itemId).tier === 'AY') ? (
            <>
              A sub-assembly line is short. An AY only gains stock by being produced — open a kit for
              it first, close that kit, and its output becomes available here (Transaction Spec §3.1).
            </>
          ) : (
            <>Some lines are short. You can still issue what is available, or receive more stock first.</>
          )}
        </RuleNote>
      )}
    </div>
  );
}

function BomRow({
  itemId,
  qtyPerUnit,
  qtyNeeded,
  depth,
}: {
  itemId: string;
  qtyPerUnit: number;
  qtyNeeded: number | null;
  depth: number;
}) {
  const stock = useReconStore((s) => s.stock);
  const [open, setOpen] = React.useState(false);
  const item = itemOf(itemId);
  const expandable = hasBom(itemId);
  const onHand = onHandTotal(stock, itemId);
  const short = qtyNeeded !== null ? Math.max(0, qtyNeeded - onHand) : 0;
  const nested: BomNode[] = open ? bomTree(itemId) : [];

  return (
    <>
      <tr className={cn('border-b border-border/60', depth > 0 && 'bg-surface/40')}>
        <td className="px-2 py-2">
          {expandable ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label={open ? `Collapse ${itemId}` : `Expand ${itemId}`}
              className="rounded-sm p-0.5 text-text-3 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : null}
        </td>
        <td className="max-w-[340px] px-3 py-2">
          <ItemCell itemId={itemId} indent={depth} />
        </td>
        <td className="px-3 py-2 text-right">
          <QtyCell value={`×${qtyPerUnit}`} tone="muted" />
        </td>
        <td className="px-3 py-2 text-right">
          {qtyNeeded === null ? (
            <QtyCell value="—" tone="muted" title="Read-only — this level is consumed as stock, not exploded" />
          ) : (
            <QtyCell value={qtyNeeded} />
          )}
        </td>
        <td className="px-3 py-2 text-right">
          <QtyCell value={onHand} tone={short > 0 ? 'danger' : undefined} />
        </td>
        <td className="px-3 py-2 text-xs text-text-2">{item.homeLocation}</td>
        <td className="px-3 py-2">
          <ExpiryBadge itemId={itemId} />
        </td>
        <td className="px-3 py-2">
          {qtyNeeded === null ? (
            <span className="text-xs text-text-3">—</span>
          ) : short > 0 ? (
            <Badge tone="danger">Short {short}</Badge>
          ) : (
            <Badge tone="success">Covered</Badge>
          )}
        </td>
      </tr>

      {open &&
        nested.map((child) => (
          <BomRow
            key={`${itemId}-${child.item.id}`}
            itemId={child.item.id}
            qtyPerUnit={child.qtyPerUnit}
            /* Read-only: the parent AY is consumed from stock, so its own
               components are not needed by *this* kit. */
            qtyNeeded={null}
            depth={depth + 1}
          />
        ))}

      {open && nested.length === 0 && (
        <tr className="border-b border-border/60 bg-surface/40">
          <td />
          <td colSpan={7} className="px-3 py-2 text-xs text-text-3" style={{ paddingLeft: (depth + 1) * 18 + 12 }}>
            No bill of materials — bought as-is.
          </td>
        </tr>
      )}
    </>
  );
}
