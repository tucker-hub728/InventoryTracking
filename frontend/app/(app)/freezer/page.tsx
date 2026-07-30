import { redirect } from 'next/navigation';

/** Retired route. The freezers are now the Cold Storage tab of Materials
 *  Management (REQ-2026-07-15-LOC-002/LOC-005); kept as a redirect so existing
 *  bookmarks still land somewhere useful. */
export default function FreezerPage() {
  redirect('/materials-management/cold-storage');
}
