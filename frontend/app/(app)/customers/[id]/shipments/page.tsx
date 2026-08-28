import { CustomerShipmentsPanel } from '@/components/customers/customer-shipments-panel';

/** The dated history — one row per signed shipment, server-paged. */
export default async function CustomerShipmentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CustomerShipmentsPanel customerId={id} />;
}
