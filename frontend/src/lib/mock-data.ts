/**
 * Single canonical entrypoint for mock data.
 *
 * Components/stores never reach into the seed directly — they go through
 * here. When/if a real API replaces the mock, only this module changes.
 */
import { seed } from './data/seed';

export const mockData = seed;
export type { MockSeed } from './data/types';
