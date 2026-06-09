import { redirect } from 'next/navigation';

interface PageProps {
  params: { id: string };
  searchParams: Record<string, string | string[] | undefined>;
}

/**
 * The item detail index has no content of its own — default to the Unit Ledger,
 * forwarding any query (e.g. ``?action=record`` deep-links) so the shell can act
 * on it.
 */
export default function InventoryDetailIndexPage({ params, searchParams }: PageProps) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === 'string') qs.set(key, value);
    else if (Array.isArray(value) && value[0] != null) qs.set(key, value[0]);
  }
  const query = qs.toString();
  redirect(`/inventory/${params.id}/ledger${query ? `?${query}` : ''}`);
}
