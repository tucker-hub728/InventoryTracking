import { redirect } from 'next/navigation';

/**
 * ``/users`` has no list of its own any more — each tab is a route. Redirect to
 * the first one so existing links, the sidebar entry and bookmarks all land
 * somewhere real instead of on an empty shell.
 */
export default function UsersPage() {
  redirect('/users/active');
}
