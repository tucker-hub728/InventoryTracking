import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind-aware className combiner used across all components. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Pluralize a noun based on count. */
export function plural(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

/** Generate a stable client-side id (collision-safe enough for UI keys). */
export function uid(prefix = ''): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

/** Matches a bare calendar date, "2026-09-23", with no time part. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse an ISO string, treating a bare calendar date as LOCAL midnight.
 *
 * ``new Date("2026-09-23")`` is defined to parse as UTC midnight, so west of
 * Greenwich it formats as the 22nd — a date-only value silently rendering as
 * the day before. Every Postgres ``DATE`` column arrives in exactly this shape
 * (expiry dates, an order's valid-from, a projected arrival), so the fix
 * belongs here rather than at each call site.
 *
 * Strings that carry a time are left alone: those are real instants and their
 * timezone conversion is correct.
 */
function parseIso(iso: string): Date {
  if (DATE_ONLY.test(iso)) {
    // Indexed rather than destructured: the regex guarantees three parts, but
    // `noUncheckedIndexedAccess` cannot know that, and Number() on a substring
    // keeps the intent obvious without a non-null assertion.
    return new Date(
      Number(iso.slice(0, 4)),
      Number(iso.slice(5, 7)) - 1,
      Number(iso.slice(8, 10)),
    );
  }
  return new Date(iso);
}

/** Format an ISO date as "May 25, 2026". Returns input unchanged if unparseable. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso || iso === '—') return '—';
  const d = parseIso(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return DATE_FMT.format(d);
}

/**
 * Whole days from today to the given ISO date. Negative = past.
 *
 * Both sides are flattened to local midnight before subtracting, so the answer
 * counts calendar days rather than 24-hour blocks. Without that, "due today"
 * reads as −1 for most of the working day and an item tips to "overdue" at an
 * arbitrary hour rather than at midnight.
 */
export function daysFromNow(iso: string | null | undefined): number | null {
  if (!iso || iso === '—') return null;
  const d = parseIso(iso);
  if (Number.isNaN(d.getTime())) return null;
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/** Format a number with thousands separators. */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

/** Truncate a string with ellipsis. */
export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Build user initials from a full name. */
export function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/**
 * True when a string looks like a canonical UUID.
 *
 * Item detail URLs carry the item's stable UUID, but older links (and anything
 * a user bookmarked) carry the human-readable item number instead. Route
 * handlers use this to decide which lookup to run before canonicalising the URL.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
