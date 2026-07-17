'use client';

import { create } from 'zustand';

import type { Kit } from './reconciliation-data';
import {
  ReconError,
  type AdjustCountInput,
  type CloseOutInput,
  type CreateKitInput,
  type ReconState,
  acknowledgeExpiry,
  additionalIssue,
  adjustCount,
  buildInitialState,
  cancelKit,
  closeOutKit,
  createKit,
  issueKit,
  setLineIssued,
  setLineReturnLocation,
  setLineSource,
  setLineUsed,
  setProductionLocation,
  startProduction,
} from './reconciliation-engine';

/**
 * In-memory kit state for the mock module.
 *
 * Deliberately NOT persisted: this is a model to explore, and every reload
 * should start from the same seeded story. The store is a thin wrapper — all
 * the rules live in reconciliation-engine.
 */
interface ReconStore extends ReconState {
  createKit: (input: CreateKitInput) => string | null;
  setLineIssued: (kitId: string, itemId: string, qty: number) => void;
  setLineSource: (kitId: string, itemId: string, location: string) => void;
  setProductionLocation: (kitId: string, location: string) => void;
  issueKit: (kitId: string, actor: string) => boolean;
  startProduction: (kitId: string) => void;
  additionalIssue: (kitId: string, itemId: string, qty: number, actor: string) => boolean;
  setLineUsed: (kitId: string, itemId: string, qty: number | null) => void;
  setLineReturnLocation: (kitId: string, itemId: string, location: string) => void;
  closeOutKit: (kitId: string, input: CloseOutInput) => boolean;
  cancelKit: (kitId: string, reason: string, actor: string) => boolean;
  adjustCount: (input: AdjustCountInput) => boolean;
  acknowledgeExpiry: (itemId: string, location: string) => void;
  resetDemo: () => void;
  /** Last rule violation, for the caller to surface. Cleared on next success. */
  lastError: string | null;
}

/** The serialisable slice — everything the engine needs, none of the actions.
 *  The engine deep-clones its input via `structuredClone`, which throws on
 *  functions, so it must never see the store's methods. */
function snapshot(store: ReconStore): ReconState {
  return {
    stock: store.stock,
    kits: store.kits,
    adjustments: store.adjustments,
    acknowledged: store.acknowledged,
    kitSeq: store.kitSeq,
    eventSeq: store.eventSeq,
    adjSeq: store.adjSeq,
  };
}

/** Runs a transition, keeping a rule violation out of state and in `lastError`. */
function guard(
  set: (partial: Partial<ReconStore>) => void,
  get: () => ReconStore,
  fn: (state: ReconState) => ReconState,
): boolean {
  try {
    const next = fn(snapshot(get()));
    set({ ...next, lastError: null });
    return true;
  } catch (err) {
    if (err instanceof ReconError) {
      set({ lastError: err.message });
      return false;
    }
    throw err;
  }
}

export const useReconStore = create<ReconStore>((set, get) => ({
  ...buildInitialState(),
  lastError: null,

  createKit: (input) => {
    let id: string | null = null;
    guard(set, get, (s) => {
      const next = createKit(s, input);
      id = next.kits[0]!.id;
      return next;
    });
    return id;
  },

  setLineIssued: (kitId, itemId, qty) => {
    guard(set, get, (s) => setLineIssued(s, kitId, itemId, qty));
  },

  setLineSource: (kitId, itemId, location) => {
    guard(set, get, (s) => setLineSource(s, kitId, itemId, location));
  },

  setProductionLocation: (kitId, location) => {
    guard(set, get, (s) => setProductionLocation(s, kitId, location));
  },

  issueKit: (kitId, actor) => guard(set, get, (s) => issueKit(s, kitId, actor)),

  startProduction: (kitId) => {
    guard(set, get, (s) => startProduction(s, kitId));
  },

  additionalIssue: (kitId, itemId, qty, actor) =>
    guard(set, get, (s) => additionalIssue(s, kitId, itemId, qty, actor)),

  setLineUsed: (kitId, itemId, qty) => {
    guard(set, get, (s) => setLineUsed(s, kitId, itemId, qty));
  },

  setLineReturnLocation: (kitId, itemId, location) => {
    guard(set, get, (s) => setLineReturnLocation(s, kitId, itemId, location));
  },

  closeOutKit: (kitId, input) => guard(set, get, (s) => closeOutKit(s, kitId, input)),

  cancelKit: (kitId, reason, actor) => guard(set, get, (s) => cancelKit(s, kitId, reason, actor)),

  adjustCount: (input) => guard(set, get, (s) => adjustCount(s, input)),

  acknowledgeExpiry: (itemId, location) => {
    guard(set, get, (s) => acknowledgeExpiry(s, itemId, location));
  },

  resetDemo: () => set({ ...buildInitialState(), lastError: null }),
}));

export function useKit(kitId: string): Kit | undefined {
  return useReconStore((s) => s.kits.find((k) => k.id === kitId));
}
