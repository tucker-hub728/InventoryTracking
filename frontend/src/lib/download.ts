/**
 * Browser file-saving helpers.
 *
 * Kept separate from ``lib/api/client.ts``: that module owns transport, this
 * one owns the DOM dance required to turn bytes into a file in the user's
 * Downloads folder. Nothing here imports the client, so there is no cycle.
 */

/** ``attachment; filename="foo.csv"`` → ``foo.csv``. Null when unparseable. */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  // RFC 5987 ``filename*=UTF-8''foo.csv`` first — it wins over the plain form
  // when both are present, and is the only one that can carry non-ASCII.
  const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || null;
}

/**
 * Hand a Blob to the browser as a download.
 *
 * The object URL is revoked on the next tick rather than immediately: Safari
 * and older Firefox abort the download if the URL dies in the same frame as
 * the synthetic click.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * ``cellready-inventory-20260825T140311Z.csv`` — the same shape the backend
 * emits, generated client-side.
 *
 * A fallback, not the primary path. The filename normally rides in on
 * ``Content-Disposition``, but that header only survives because the BFF proxy
 * explicitly forwards it, and that proxy is an auth file somebody will refactor
 * one day. A download that silently lands as "inventory.csv" — or worse,
 * "download" — is a bad enough outcome to be worth eight lines of insurance.
 */
export function timestampedFilename(prefix: string, extension: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${prefix}-${stamp}.${extension}`;
}
