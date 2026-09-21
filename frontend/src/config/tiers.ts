/**
 * The three item tiers and their per-page labelling.
 *
 * REQ-2026-07-15-ITM-001: exactly three tiers exist — raw material,
 * sub-assembly and finished good. Admin-added prefixes live *inside* one of
 * these and never constitute a fourth tier, so this list is fixed by
 * design and is not admin-extensible.
 *
 * These are module constants, but they are NOT referentially stable where they
 * are used: the routes are server components, so the object is serialized to
 * ``TierListClient`` and re-delivered as a fresh copy on every router.replace.
 * Never make one an effect dependency — key on ``type`` instead.
 */

import type { TierConfig, TierFilter } from '@/components/inventory/tier-list-client';

/**
 * "Needs reorder" — at or below the reorder threshold.
 *
 * Deliberately not ``status: 'low_stock'``. ``v_item_stock`` tests
 * ``qty_available <= 0`` *before* the threshold, so an item sitting at zero is
 * classed ``out_of_stock`` and a low_stock filter would hide it — exactly the
 * rows that most need ordering.
 */
const NEEDS_REORDER: TierFilter = {
  id: 'needs-reorder',
  label: 'Needs reorder',
  params: { below_reorder: true },
};

/**
 * "Missing BOM" — built items nobody has given a recipe yet. A sub-assembly or
 * finished good without a BOM can't be kitted or planned, so it's a data gap
 * worth surfacing. Only offered on the built tiers: a raw material is bought,
 * not assembled, so it has no BOM by definition.
 */
const MISSING_BOM: TierFilter = {
  id: 'missing-bom',
  label: 'Missing BOM',
  params: { has_bom: false },
};

/**
 * "Awaiting release" — stock that has ARRIVED but has not been placed and
 * released (REQ-2026-07-31-STS-001).
 *
 * CR-only, because only purchased material is received: a built item's stock is
 * minted by a kit close-out, which places it directly. Worth its own filter
 * because this material is easy to lose track of — it is on site and paid for,
 * yet it counts towards nothing until somebody signs it in, so an item can look
 * short while a box of it sits in receiving.
 */
const AWAITING_RELEASE: TierFilter = {
  id: 'awaiting-release',
  label: 'Awaiting release',
  params: { awaiting_release: true },
};

const ALL: TierFilter = { id: 'all', label: 'All' };

/** CR — off-the-shelf raw material purchased externally (REQ-2026-07-01-INV-002). */
export const RAW_MATERIAL_TIER: TierConfig = {
  prefix: 'CR',
  type: 'raw_material',
  title: 'Raw Materials',
  singular: 'raw material',
  plural: 'raw materials',
  newLabel: 'New Raw Material',
  createdLabel: 'Raw material created',
  // Purchased items are received into stock, so they open the unit ledger.
  detailSegment: 'ledger',
  // Consumable is CR-only (Transaction Spec §1.1), so only this tier splits on it.
  filters: [
    ALL,
    { id: 'consumables', label: 'Consumables', params: { is_consumable: true } },
    {
      id: 'non-consumables',
      label: 'Non-consumables',
      params: { is_consumable: false },
    },
    NEEDS_REORDER,
    AWAITING_RELEASE,
  ],
};

/** AY — built from two or more CR items and itself stockable (REQ-2026-07-01-INV-003). */
export const SUB_ASSEMBLY_TIER: TierConfig = {
  prefix: 'AY',
  type: 'sub_assembly',
  title: 'Sub-Assemblies',
  singular: 'sub-assembly',
  plural: 'sub-assemblies',
  newLabel: 'New Sub-Assembly',
  createdLabel: 'Sub-assembly created',
  // Built items open on their Unit Ledger — the default tab (since kitting,
  // built items hold real stock and get a ledger).
  detailSegment: 'ledger',
  filters: [ALL, MISSING_BOM, NEEDS_REORDER],
};

/** FG — finished good; renamed from "Products" for COGS semantics (REQ-2026-07-01-INV-006). */
export const FINISHED_GOOD_TIER: TierConfig = {
  prefix: 'FG',
  type: 'finished_good',
  title: 'Finished Goods',
  singular: 'finished good',
  plural: 'finished goods',
  newLabel: 'New Finished Good',
  createdLabel: 'Finished good created',
  detailSegment: 'ledger',
  filters: [ALL, MISSING_BOM, NEEDS_REORDER],
};
