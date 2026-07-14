'use client';

import * as React from 'react';

import type { InventoryItem, LedgerEntry } from '@/types/inventory';

export interface InventoryLedgerState {
  entries: LedgerEntry[];
  loading: boolean;
  error: string | null;
  total: number;
}

export interface InventoryDetailContextValue {
  item: InventoryItem;
  /** Re-fetch the item + ledger (after a movement / edit). */
  refresh: () => void;
  ledger: InventoryLedgerState;
  /** Set when the per-row reverse action is enabled (currently hidden). */
  onReverseRequest?: (entry: LedgerEntry) => void;
  canSign: boolean;
}

const InventoryDetailContext = React.createContext<InventoryDetailContextValue | null>(null);

/** Provided by the inventory detail layout/shell; consumed by the tab panels. */
export function InventoryDetailProvider({
  value,
  children,
}: {
  value: InventoryDetailContextValue;
  children: React.ReactNode;
}) {
  return (
    <InventoryDetailContext.Provider value={value}>{children}</InventoryDetailContext.Provider>
  );
}

export function useInventoryDetail(): InventoryDetailContextValue {
  const ctx = React.useContext(InventoryDetailContext);
  if (!ctx) {
    throw new Error('useInventoryDetail must be used within the inventory detail layout');
  }
  return ctx;
}
