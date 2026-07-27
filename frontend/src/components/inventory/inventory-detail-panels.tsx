'use client';

import * as React from 'react';

import { useMinDuration } from '@/hooks/use-min-duration';
import { isBuiltTier } from '@/lib/api/tiers';
import { EmptyState } from '@/components/shared/empty-state';
import { TableSkeleton } from '@/components/shared/table-skeleton';
import { EntityAuditTimeline } from '@/components/admin/audit/entity-audit-timeline';

import { LedgerExpiryToolbar, LedgerTable, useLedgerExpiryControls } from './ledger-table';
import { ForecastImpactTab } from './forecast-impact-tab';
import { ItemBomTab } from './item-bom-tab';
import { ItemWhereUsedTab } from './item-where-used-tab';
import { ItemBomTreeTab } from './item-bom-tree-tab';
import { useInventoryDetail } from './inventory-detail-context';

/**
 * The inventory item's tab panels, each rendered by its own route under
 * ``/inventory/[id]/...`` and reading the shared item/ledger from context.
 */

export function ItemLedgerPanel() {
  const { item, ledger, onReverseRequest } = useInventoryDetail();
  // The near-expiry window is a per-item setting, managed from the
  // create / edit item dialogs. The ledger only *reads* it to colour the
  // expiry pills (green / amber / red) — no editing here.
  const controls = useLedgerExpiryControls(ledger.entries, item.nearExpiryThresholdDays);
  // Held briefly — the fetch returns in ~20ms, too fast to see otherwise.
  const showSkeleton = useMinDuration(ledger.loading && ledger.entries.length === 0);

  if (ledger.error) {
    return <EmptyState title="Couldn't load ledger" hint={ledger.error} />;
  }
  if (showSkeleton) {
    return <TableSkeleton rows={6} columns={7} label="Loading ledger…" />;
  }
  if (ledger.entries.length === 0) {
    return <EmptyState title="No movements yet" hint="Recorded transactions will appear here." />;
  }

  // Toolbar sits outside the horizontal-scroll container so the filter never
  // scrolls with the table. Its padding matches the table cells' ``px-3.5`` so
  // the controls line up with the columns, with top room off the tab bar.
  return (
    <div>
      <div className="px-3.5 pb-3 pt-4">
        <LedgerExpiryToolbar
          statusFilter={controls.statusFilter}
          setStatusFilter={controls.setStatusFilter}
          withinInput={controls.withinInput}
          setWithinInput={controls.setWithinInput}
          filtersActive={controls.filtersActive}
          resetFilters={controls.resetFilters}
          visibleLots={controls.visibleLots}
          totalLots={controls.totalLots}
        />
      </div>
      <div className="overflow-x-auto">
        <LedgerTable
          groups={controls.groups}
          nearExpiryThresholdDays={item.nearExpiryThresholdDays}
          sortDir={controls.sortDir}
          onCycleSort={controls.cycleSort}
          filtersActive={controls.filtersActive}
          onReverseRequest={onReverseRequest}
          // Only built items (finished goods / sub-assemblies) can ship to a
          // customer, so the Customer column is shown only for them.
          showCustomer={isBuiltTier(item.tierType)}
        />
      </div>
    </div>
  );
}

/** "Used in" tab (the ``products`` segment) — the where-used view, shown for
 *  non-consumable raw materials and for built tiers (AY/FG) alike. */
export function ItemProductsPanel() {
  const { item } = useInventoryDetail();
  return <ItemWhereUsedTab itemId={item.uuid} />;
}

/** Product "BOM" tab — the direct bill-of-materials editor (built items only).
 *  Where-used lives in its own "Used in" tab (ItemProductsPanel). */
export function ItemBomPanel() {
  const { item } = useInventoryDetail();
  return <ItemBomTab itemId={item.uuid} itemNumber={item.id} itemTierType={item.tierType} />;
}

/** Product "Structure" tab — the read-only multi-level BOM hierarchy. */
export function ItemStructurePanel() {
  const { item } = useInventoryDetail();
  return <ItemBomTreeTab itemId={item.uuid} itemNumber={item.id} />;
}

export function ItemForecastPanel() {
  const { item } = useInventoryDetail();
  // Forecasting uses *available* (date-expired units excluded).
  return <ForecastImpactTab itemId={item.uuid} onHand={item.qtyAvailable} />;
}

export function ItemAuditPanel() {
  const { item } = useInventoryDetail();
  // EVERY item (raw material, sub-assembly, finished good) folds in the
  // kitting/reconciliation events for kits it took part in (AUD-001) — the
  // good/scrap/consumed/output that never moves stock. A raw material consumed
  // in a batch must show that consumption too, not just built items (client
  // 2026-07-24). The per-event involvement filter scopes each to this item.
  return (
    <EntityAuditTimeline
      subjectTable="app.items"
      subjectId={item.uuid}
      kitAuditItemId={item.uuid}
    />
  );
}
