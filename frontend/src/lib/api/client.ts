/**
 * Browser-side API client. Every call hits ``/api/v1/...`` which is the
 * Next.js BFF proxy (see ``app/api/v1/[...path]/route.ts``) — never the
 * FastAPI backend directly. The proxy attaches the access token from
 * the HttpOnly cookie, so this client never touches credentials.
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  request_id?: string | null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  /** Query string params; values stringified. ``undefined`` is dropped. */
  /** An array value becomes a repeated parameter (?k=a&k=b). */
  query?: Record<
    string,
    string | number | boolean | undefined | null | readonly (string | number)[]
  >;
  /** JSON body — will be serialised. Mutually exclusive with rawBody. */
  json?: unknown;
  /** Abort signal for cancellable requests. */
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(
    `/api/v1${path.startsWith('/') ? path : `/${path}`}`,
    typeof window === 'undefined' ? 'http://placeholder' : window.location.origin,
  );
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      // An array becomes a REPEATED parameter (?status=a&status=b), which is
      // what FastAPI parses into a list. ``set`` with the array would stringify
      // it to "a,b" and arrive as one nonsense value.
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v === undefined || v === null || v === '') continue;
          url.searchParams.append(key, String(v));
        }
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.pathname + url.search;
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = buildUrl(path, opts.query);
  const init: RequestInit = {
    method,
    credentials: 'include',
    cache: 'no-store',
    signal: opts.signal,
    headers: opts.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  };

  const resp = await fetch(url, init);

  // 204 No Content — return undefined as T (caller expects void).
  if (resp.status === 204) return undefined as T;

  const text = await resp.text();
  let body: unknown = text;
  if (text && resp.headers.get('content-type')?.includes('application/json')) {
    try {
      body = JSON.parse(text);
    } catch {
      // Server claimed JSON but sent malformed — fall through as text.
    }
  }

  if (!resp.ok) {
    const err = (body as ApiErrorBody) ?? {};
    // A user deactivated mid-session gets 403 ``account_disabled`` on every
    // call. The BFF has already cleared the token cookies; bounce them to the
    // login screen with a notice so they can't keep clicking a dead session.
    if (err.code === 'account_disabled' && typeof window !== 'undefined') {
      window.location.href = '/login?reason=deactivated';
    }
    throw new ApiError(
      resp.status,
      err.code ?? 'unknown_error',
      err.message ?? resp.statusText,
      err.details,
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, opts?: RequestOptions) => request<T>('POST', path, opts),
  patch: <T>(path: string, opts?: RequestOptions) => request<T>('PATCH', path, opts),
  put: <T>(path: string, opts?: RequestOptions) => request<T>('PUT', path, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
};
