/**
 * Tiny deterministic PRNG (mulberry32) for stable demo layouts.
 * The same seed string always yields the same sequence — used by the
 * LN2 tank map and Kanban board to keep visuals consistent across renders.
 */
function xfnv1a(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seededRandom(seed: string): () => number {
  let state = xfnv1a(seed);
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickSeeded<T>(seed: string, arr: readonly T[]): T {
  const rand = seededRandom(seed);
  return arr[Math.floor(rand() * arr.length)]!;
}
