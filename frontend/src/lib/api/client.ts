/**
 * Browser-side API client. Every call hits ``/api/v1/...`` which is the
 * Next.js BFF proxy (see ``app/api/v1/[...path]/route.ts``) — never the
 * FastAPI backend directly. The proxy attaches the access token from
 * the HttpOnly cookie, so this client never touches credentials.
 */

import { filenameFromContentDisposition } from '@/lib/download';

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

/** Best-effort JSON parse of a body that may or may not actually be JSON. */
function parseBody(text: string, contentType: string | null): unknown {
  if (text && contentType?.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      // Server claimed JSON but sent malformed — fall through as text.
    }
  }
  return text;
}

/**
 * Turn a non-OK response into an ``ApiError`` and throw.
 *
 * Shared by ``request`` and ``download`` so a file download gets exactly the
 * same failure handling as a JSON call — including the deactivated-user
 * bounce, which is easy to forget on a second code path.
 */
function raiseApiError(resp: Response, body: unknown): never {
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
  const body = parseBody(text, resp.headers.get('content-type'));

  if (!resp.ok) raiseApiError(resp, body);
  return body as T;
}

export interface DownloadResult {
  blob: Blob;
  /** Parsed from ``Content-Disposition``; null when the header didn't survive. */
  filename: string | null;
}

/**
 * GET a file. Separate from ``request`` because that one calls ``resp.text()``
 * unconditionally and assumes JSON.
 *
 * Why fetch-then-save rather than a plain ``<a href>``: an anchor would hit
 * this same BFF route and so would get the token and the 401-refresh retry —
 * but when a refresh ultimately *fails*, the proxy answers with a JSON error
 * envelope and the browser cheerfully saves it under the download's filename.
 * Finance then opens an authentication error in Excel. Going through fetch
 * lets us check the status and the content type before anything is written to
 * disk, and gives the caller a pending state and a real error to surface.
 */
async function download(path: string, opts: RequestOptions = {}): Promise<DownloadResult> {
  const resp = await fetch(buildUrl(path, opts.query), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    signal: opts.signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    raiseApiError(resp, parseBody(text, resp.headers.get('content-type')));
  }

  // A 2xx carrying JSON is not the file we asked for. Refusing here is what
  // stops an error envelope being saved to disk with a ``.csv`` name.
  const contentType = resp.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    throw new ApiError(
      resp.status,
      'unexpected_response',
      'The server returned data instead of a file. Please try again.',
    );
  }

  return {
    blob: await resp.blob(),
    filename: filenameFromContentDisposition(resp.headers.get('content-disposition')),
  };
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, opts?: RequestOptions) => request<T>('POST', path, opts),
  patch: <T>(path: string, opts?: RequestOptions) => request<T>('PATCH', path, opts),
  put: <T>(path: string, opts?: RequestOptions) => request<T>('PUT', path, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
  download,
};
