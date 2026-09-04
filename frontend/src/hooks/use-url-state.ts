'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { useDebouncedValue } from './use-debounced-value';

/**
 * Query-string state for server-paged tables.
 *
 * The URL is the single source of truth for "what am I looking at": page
 * number, rows-per-page and every filter. Refreshing, bookmarking or pasting
 * the link to a colleague reproduces the exact view — which is the whole point
 * on an audit screen, where "here's the row I'm asking about" has to survive
 * being sent to somebody else.
 *
 * Values equal to their default are **omitted** from the URL, so the common
 * case stays a clean ``/audit`` rather than ``/audit?page=1&size=25&q=``.
 *
 * Navigation uses ``router.replace``, not ``push``: a filter bar generates a
 * change per keystroke and per dropdown, and pushing each one would bury the
 * page the user actually came from under fifty history entries. Refresh,
 * bookmark and share all work either way — those read the current URL, which
 * ``replace`` updates.
 */

type Primitive = string | number;

/**
 * ``defaults`` defines both the shape and the coercion: a numeric default means
 * the param is parsed as a number, a string default means it's read verbatim.
 * It MUST be a stable reference (declare it as a module-level constant) — it is
 * read through a ref, so a fresh object literal each render would not re-derive
 * the state but would silently make ``reset`` compare against the newest copy.
 */
export function useUrlState<T extends Record<string, Primitive>>(
  defaults: T,
): {
  value: T;
  /** Merge a patch into the query string. Keys at their default are dropped. */
  set: (patch: Partial<T>) => void;
  /** Clear every key this hook owns, leaving unrelated params untouched. */
  reset: () => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const defaultsRef = React.useRef(defaults);
  defaultsRef.current = defaults;

  // ``searchParams`` is a new object identity on every navigation; the string
  // form is the stable thing to memoise on.
  const search = searchParams.toString();

  const value = React.useMemo(() => {
    const params = new URLSearchParams(search);
    const out = { ...defaultsRef.current };
    for (const key of Object.keys(out) as (keyof T & string)[]) {
      const raw = params.get(key);
      if (raw === null || raw === '') continue;
      const fallback = out[key];
      if (typeof fallback === 'number') {
        const parsed = Number(raw);
        out[key] = (Number.isFinite(parsed) ? parsed : fallback) as T[typeof key];
      } else {
        out[key] = raw as T[typeof key];
      }
    }
    return out;
  }, [search]);

  const set = React.useCallback(
    (patch: Partial<T>) => {
      const params = new URLSearchParams(search);
      for (const [key, next] of Object.entries(patch)) {
        if (next === undefined) continue;
        if (next === defaultsRef.current[key]) params.delete(key);
        else params.set(key, String(next));
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, search],
  );

  const reset = React.useCallback(() => {
    const params = new URLSearchParams(search);
    for (const key of Object.keys(defaultsRef.current)) params.delete(key);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router, search]);

  return { value, set, reset };
}

/**
 * Coerce a URL-supplied string to one of a known set.
 *
 * Query params are user-editable and outlive the code that wrote them — a
 * bookmark from an older build can carry a filter value that no longer exists.
 * Sending that straight to the API turns a stale link into a 422 and an error
 * screen; falling back to the default just shows the unfiltered view.
 */
export function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Clamp a URL-supplied number into range, falling back when it isn't one.
 *  Keeps ``?size=99999`` from tripping the endpoint's ``limit`` ceiling. */
export function clampInt(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Local mirror of a URL-backed search box.
 *
 * Typing has to feel instant, but writing the URL on every keystroke makes the
 * caret fight the router. So the input owns a draft, and the draft is committed
 * to the URL on a debounce.
 *
 * The ``lastPushed`` ref is what keeps the two directions from clobbering each
 * other. Without it, the commit's own echo (URL → draft) would overwrite
 * characters typed while the previous value was still in flight: type "abc"
 * fast enough and the "ab" landing in the URL would rewind the box to "ab".
 * Comparing against the last value *this hook* moved distinguishes our own echo
 * from a genuine outside change — "Clear filters", the back button, or a link
 * somebody pasted — which we do want to adopt.
 */
export function useUrlSearchBox(
  urlValue: string,
  commit: (next: string) => void,
  delay = 250,
): [string, (next: string) => void] {
  const [draft, setDraft] = React.useState(urlValue);
  const debounced = useDebouncedValue(draft, delay);

  const commitRef = React.useRef(commit);
  commitRef.current = commit;
  const lastPushed = React.useRef(urlValue);

  React.useEffect(() => {
    if (urlValue === lastPushed.current) return;
    lastPushed.current = urlValue;
    setDraft(urlValue);
  }, [urlValue]);

  React.useEffect(() => {
    if (debounced === lastPushed.current) return;
    lastPushed.current = debounced;
    commitRef.current(debounced);
  }, [debounced]);

  return [draft, setDraft];
}
