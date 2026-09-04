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
  /**
   * Bumped when something changes that a tab must re-read but ``refresh`` alone
   * doesn't reach — a release-state change made from the header.
   *
   * ``refresh`` re-fetches the item, which the ledger picks up because its
   * effect keys on the item object. The Stock by location tab deliberately
   * keys on ``item.uuid`` (a stable string) so it does NOT re-fetch on every
   * parent render, and would otherwise sit on stale badges.
   */
  refreshSeq: number;
  /**
   * Open the header's Issue dialog, optionally aimed at a Kanban that asked for
   * a restock (KAN-001).
   *
   * A tab reaching back into the header looks odd until you consider the
   * alternative: a second Issue dialog mounted inside the tab. That is a second
   * copy of an e-signed flow — its own source picker, its own signature
   * binding, its own grid handling — and the two would drift, which in this
   * codebase has already meant emptying the wrong LN2 vials. One dialog, one
   * place, reachable from both.
   */
  openIssue?: (prefill: { kanbanNodeId: string; qty: number | null } | null) => void;
  /**
   * Tell the page a restock request changed, so surfaces OUTSIDE the tab
   * re-read — chiefly the banner above the tabs.
   *
   * Needed because the two surfaces refresh in opposite directions: an issue
   * starts at the header and has to reach the tab, an acknowledgment starts in
   * the tab and has to reach the banner. Each used to bump its own counter, so
   * each updated itself and left the other showing a request that had already
   * been answered.
   */
  onRestockChanged?: () => void;
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
