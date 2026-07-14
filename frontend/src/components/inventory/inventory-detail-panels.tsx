'use client';

import * as React from 'react';

import { EmptyState } from '@/components/shared/empty-state';
import { EntityAuditTimeline } from '@/components/admin/audit/entity-audit-timeline';

import { LedgerExpiryToolbar, LedgerTable, useLedgerExpiryControls } from './ledger-table';
import { ForecastImpactTab } from './forecast-impact-tab';
import { ItemBomTab } from './item-bom-tab';
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

  if (ledger.error) {
    return <EmptyState title="Couldn't load ledger" hint={ledger.error} />;
  }
  if (ledger.loading && ledger.entries.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-text-3" role="status">
        Loading ledger…
      </div>
    );
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
        />
      </div>
    </div>
  );
}

/** Purchased "Products" tab + Product "BOM" tab both use ItemBomTab, which
 *  branches on the item kind (purchased → where-used only; built → BOM editor
 *  + where-used). */
export function ItemProductsPanel() {
  const { item } = useInventoryDetail();
  return (
    <ItemBomTab
      itemId={item.uuid}
      itemNumber={item.id}
      itemKind={item.categoryKind}
    />
  );
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
  return <EntityAuditTimeline subjectTable="app.items" subjectId={item.uuid} />;
}
