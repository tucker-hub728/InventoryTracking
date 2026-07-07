import { redirect } from 'next/navigation';

// Inventory is tier-scoped now (CR / AY / FG). The bare /inventory path
// lands on the raw-material (CR) tier; old links/bookmarks keep working.
export default function InventoryIndexPage() {
  redirect('/inventory/cr');
}
