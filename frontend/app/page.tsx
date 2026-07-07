import { redirect } from 'next/navigation';

/** Root → canonical inventory entry. AuthGuard inside (app) redirects unauthed. */
export default function RootPage() {
  redirect('/inventory/cr');
}
