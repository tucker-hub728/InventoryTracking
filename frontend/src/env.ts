/**
 * Centralized env access.
 *
 * Public envs (NEXT_PUBLIC_*) are inlined at build time; everything goes
 * through this module so we have a single audit point and consistent
 * defaults.
 *
 * Server-only values live in `serverEnv` and must NEVER be imported from a
 * client component — importing this object pulls server-only secrets into
 * the client bundle. Importing `env` (public) anywhere is fine.
 */
const get = (key: string, fallback = ''): string => {
  const v = process.env[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
};

const getInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const env = {
  APP_NAME: get('NEXT_PUBLIC_APP_NAME', 'IMS'),
  APP_FULL_NAME: get('NEXT_PUBLIC_APP_FULL_NAME', 'Inventory Management System'),
  API_BASE_URL: get('NEXT_PUBLIC_API_BASE_URL', 'http://localhost:8000/v1'),
  ENV_LABEL: get(
    'NEXT_PUBLIC_ENV_LABEL',
    '21 CFR Part 11 environment · all actions are logged',
  ),
  IS_PROD: process.env.NODE_ENV === 'production',
  IS_DEV: process.env.NODE_ENV === 'development',
} as const;

/**
 * Server-only env. Importing this from a client component will throw at
 * build/runtime once Next.js tree-shakes — keep usage to route handlers,
 * middleware, and server components.
 */
export const serverEnv = {
  /** URL the route handlers use to reach the backend. Server-network. */
  BACKEND_INTERNAL_URL: get(
    'BACKEND_INTERNAL_URL',
    get('NEXT_PUBLIC_API_BASE_URL', 'http://localhost:8000/v1'),
  ),
  /** Access-token cookie max-age, in seconds. Must match Cognito client. */
  ACCESS_TOKEN_TTL_SECONDS: getInt('JWT_ACCESS_TOKEN_TTL_MINUTES', 60) * 60,
  /** Refresh-token cookie max-age, in seconds. Must match Cognito client. */
  REFRESH_TOKEN_TTL_SECONDS: getInt('JWT_REFRESH_TOKEN_TTL_DAYS', 30) * 86_400,
} as const;
