import { redirect } from 'next/navigation';

/** Each Reorder group is a route; send the bare path to the one that answers
 *  the more common question. */
export default function PlanningPage() {
  redirect('/planning/order');
}
