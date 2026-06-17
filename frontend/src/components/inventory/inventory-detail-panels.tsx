'use client';

import * as React from 'react';

import { EmptyState } from '@/components/shared/empty-state';
import { ItemProductsTab } from '@/components/products/item-products-tab';
import { EntityAuditTimeline } from '@/components/admin/audit/entity-audit-timeline';

import { LedgerTable } from './ledger-table';
import { ForecastImpactTab } from './forecast-impact-tab';
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
  return (
    <div className="overflow-x-auto">
      {ledger.error ? (
        <EmptyState title="Couldn't load ledger" hint={ledger.error} />
      ) : ledger.loading && ledger.entries.length === 0 ? (
        <div className="py-10 text-center text-sm text-text-3" role="status">
          Loading ledger…
        </div>
      ) : (
        <LedgerTable
          entries={ledger.entries}
          nearExpiryThresholdDays={item.nearExpiryThresholdDays}
          onReverseRequest={onReverseRequest}
        />
      )}
    </div>
  );
}

export function ItemProductsPanel() {
  const { item } = useInventoryDetail();
  return <ItemProductsTab itemId={item.uuid} />;
}

export function ItemForecastPanel() {
  const { item } = useInventoryDetail();
  return <ForecastImpactTab itemId={item.uuid} onHand={item.qty} />;
}

export function ItemAuditPanel() {
  const { item } = useInventoryDetail();
  return <EntityAuditTimeline subjectTable="app.items" subjectId={item.uuid} />;
}
