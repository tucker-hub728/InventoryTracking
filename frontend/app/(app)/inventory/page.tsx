import { redirect } from 'next/navigation';

// The combined inventory list is disabled — items are managed per tier now
// (e.g. Raw Materials at /inventory/cr). Anyone landing on the old index is
// forwarded to the Raw Materials section.
export default function InventoryPage() {
  redirect('/inventory/cr');
}
