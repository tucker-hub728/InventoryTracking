/**
 * Static site configuration. Reads from public env vars so deploy targets
 * can rebrand without code changes; falls back to sensible defaults so
 * the app boots even when env isn't set up yet.
 */
export const siteConfig = {
  shortName: process.env.NEXT_PUBLIC_APP_NAME ?? 'IMS',
  name: process.env.NEXT_PUBLIC_APP_FULL_NAME ?? 'Inventory Management System',
  description:
    'Production-grade inventory, LN2 tank, and Kanban management for regulated cell-therapy operations.',
  envLabel:
    process.env.NEXT_PUBLIC_ENV_LABEL ??
    '21 CFR Part 11 environment · all actions are logged',
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api',
} as const;

export type SiteConfig = typeof siteConfig;
