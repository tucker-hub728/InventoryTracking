import { ProductMaterialsPanel } from '@/components/products/product-materials-panel';

interface PageProps {
  params: { id: string };
}

export default function ProductMaterialPage({ params }: PageProps) {
  return <ProductMaterialsPanel productId={params.id} />;
}
