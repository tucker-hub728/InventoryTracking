import { redirect } from 'next/navigation';

import { DEFAULT_MM_TAB } from '@/components/materials-management/mm-tabs';

/** Bare `/materials-management` has no content of its own — every view is a
 *  tab, so land on the first one. */
export default function MaterialsManagementIndexPage() {
  redirect(`/materials-management/${DEFAULT_MM_TAB}`);
}
