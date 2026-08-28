'use client';

import * as React from 'react';

import { useMinDuration } from '@/hooks/use-min-duration';
import { kitsApi, type ApiItemKitConsumption } from '@/lib/api/kits';
import { EmptyState } from '@/components/shared/empty-state';
import { TableSkeleton } from '@/components/shared/table-skeleton';
import { EntityAuditTimeline } from '@/components/admin/audit/entity-audit-timeline';

import { LedgerExpiryToolbar, LedgerTable, useLedgerExpiryControls } from './ledger-table';
import { ForecastImpactTab } from './forecast-impact-tab';
import { ItemBomTab } from './item-bom-tab';
import { ItemRestockRequestsTab } from './item-restock-requests-tab';
import { ItemStockLocationsTab } from './item-stock-locations-tab';
import { ItemWhereUsedTab } from './item-where-used-tab';
import { ItemBomTreeTab } from './item-bom-tree-tab';
import { useInventoryDetail } from './inventory-detail-context';

/**
 * The inventory item's tab panels, each rendered by its own route under
 * ``/inventory/[id]/...`` and reading the shared item/ledger from context.
 */

export function ItemLedgerPanel() {
  const { item, ledger, onReverseRequest } = useInventoryDetail();
  // Per-kit consumption for this item. Using material writes no stock movement
  // (it left the balance at Kitted time), so the ledger can't show the "used"
  // figure REQ-2026-07-09-TRX-003 asks for without this. Failure is silent —
  // the ledger is still perfectly readable without the reconciliation lines.
  const [kitUsage, setKitUsage] = React.useState<ApiItemKitConsumption[]>([]);
  React.useEffect(() => {
    const ctrl = new AbortController();
    kitsApi
      .itemConsumption(item.uuid, { signal: ctrl.signal })
      .then((r) => setKitUsage(r.lines))
      .catch(() => {});
    return () => ctrl.abort();
  }, [item.uuid]);
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
          releaseFilter={controls.releaseFilter}
          setReleaseFilter={controls.setReleaseFilter}
          presentReleaseStates={controls.presentReleaseStates}
          filtersActive={controls.filtersActive}
          resetFilters={controls.resetFilters}
          visibleLots={controls.visibleLots}
          totalLots={controls.totalLots}
        />
      </div>
      {/* No overflow here on purpose: ``Table`` brings its own scroll container
          and that is the one sticky anchors to, so a second one around it only
          made the scrollbars fight. The height lives on the table (see
          ``containerClassName`` in LedgerTable). */}
      <div>
        <LedgerTable
          groups={controls.groups}
          nearExpiryThresholdDays={item.nearExpiryThresholdDays}
          sortDir={controls.sortDir}
          onCycleSort={controls.cycleSort}
          filtersActive={controls.filtersActive}
          onReverseRequest={onReverseRequest}
          // Shown wherever a customer shipment is POSSIBLE, which since
          // TRX-001 means every tier — a raw material may be issued to a
          // customer too, so hiding the column on CR pages left those
          // shipments with no visible recipient. Only a consumable is
          // excluded: it is consumed on issue, so it never ships.
          showCustomer={!item.isConsumable}
          kitUsage={kitUsage}
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

/** "Stock by location" tab — where the item physically is, with a per-row
 *  Transfer action (INV-007 / TRX-001). Shown for every tier: a built item
 *  holds real stock too, once a kit close-out has placed its output. */
export function ItemStockPanel() {
  const { item, refresh, canSign, refreshSeq } = useInventoryDetail();
  return (
    <ItemStockLocationsTab
      // Remounted when a release state changes elsewhere on the page, which is
      // the house pattern here (see ``AllocationActions`` in the location
      // panel). Losing the tab's filter selection is the right trade: the lot
      // has just left whichever state was being filtered on.
      key={refreshSeq}
      item={{ uuid: item.uuid, id: item.id, desc: item.desc }}
      nearExpiryThresholdDays={item.nearExpiryThresholdDays}
      canSign={canSign}
      onChanged={refresh}
    />
  );
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

/** "Restock requests" tab — every ask raised against this consumable (KAN-001).
 *
 *  Consumables only; a non-consumable cannot be issued to a Kanban, so the tab
 *  could never fill. See ``tabsForItem``.
 *
 *  ``openIssue`` reaches back to the header's dialog rather than mounting a
 *  second one here — see the context field's own note for why a duplicate
 *  e-signed flow is the wrong trade. */
export function ItemRestockRequestsPanel() {
  const { item, canSign, openIssue, onRestockChanged, refreshSeq } = useInventoryDetail();
  return (
    <ItemRestockRequestsTab
      // A PROP, not ``key``. Re-keying would remount the tab and throw the
      // operator back to page 1 with the filter reset — after acknowledging a
      // row on page 3, which is exactly when that hurts. The tab refetches in
      // place and keeps where they were.
      reloadKey={refreshSeq}
      itemId={item.uuid}
      canSign={canSign}
      onIssue={openIssue}
      onChanged={onRestockChanged}
    />
  );
}
