import { redirect } from 'next/navigation';

/** Retired route. REQ-2026-07-15-LOC-005 places Warehouse One inside the
 *  Materials Management room, so it is a tab there rather than a page of its
 *  own; kept as a redirect for existing bookmarks. */
export default function WarehousePage() {
  redirect('/materials-management/warehouse');
}
