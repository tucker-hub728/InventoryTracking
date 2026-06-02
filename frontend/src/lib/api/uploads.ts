/**
 * Upload-related endpoints. Currently just the signature image used by
 * ``PasswordReauthDialog`` — the canvas drawing the operator scribbles
 * before typing their password. The backend stashes it in S3 (MinIO in
 * dev) and returns the object key, which the caller then passes to
 * ``authApi.reauth`` as ``signature_image_s3_key``.
 *
 * The general JSON ``api`` client doesn't speak multipart, so this
 * module uses ``fetch`` directly. Mirrors the ApiError translation so
 * callers see the same shape as the rest of the surface.
 */

import { ApiError, type ApiErrorBody } from './client';

export interface UploadedSignature {
  key: string;
  content_type: string;
  size: number;
}

/**
 * Upload a single signature image. ``blob`` should be a PNG / JPEG /
 * WebP image from a canvas ``toBlob`` call. The backend caps size at
 * 2 MB and rejects unsupported types with a structured 422.
 */
export async function uploadSignature(
  blob: Blob,
  opts?: { signal?: AbortSignal },
): Promise<UploadedSignature> {
  const form = new FormData();
  // Filename only used for human display in S3 console; the actual
  // object key is generated server-side.
  form.append('file', blob, 'signature.png');

  const resp = await fetch('/api/v1/uploads/signature', {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    body: form,
    signal: opts?.signal,
  });

  // Don't try to JSON-parse a 204 (signature endpoint won't emit one,
  // but keeps the shape consistent).
  if (resp.status === 204) {
    throw new ApiError(204, 'unexpected_no_content', 'No content from upload');
  }

  const text = await resp.text();
  let parsed: unknown = text;
  if (text && resp.headers.get('content-type')?.includes('application/json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // fall through — parsed stays as text
    }
  }

  if (!resp.ok) {
    const err = (parsed as ApiErrorBody) ?? {};
    throw new ApiError(
      resp.status,
      err.code ?? 'unknown_error',
      err.message ?? resp.statusText,
      err.details,
    );
  }

  return parsed as UploadedSignature;
}

/**
 * URL the audit viewer / debug tools can use to render the signature
 * image inline. Goes through the BFF proxy so credentials live in the
 * cookie, not in URL params.
 */
export function signatureImageUrl(evidenceId: string): string {
  return `/api/v1/uploads/signature/${encodeURIComponent(evidenceId)}`;
}
