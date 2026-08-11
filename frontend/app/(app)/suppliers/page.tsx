import { redirect } from 'next/navigation';

/** Each supplier tab is a route; send the bare path to the first one. */
export default function SuppliersPage() {
  redirect('/suppliers/active');
}
