import { ProductCustomersTab } from '@/components/products/product-customers-tab';

interface PageProps {
  params: { id: string };
}

export default function ProductCustomersPage({ params }: PageProps) {
  return <ProductCustomersTab productId={params.id} />;
}
