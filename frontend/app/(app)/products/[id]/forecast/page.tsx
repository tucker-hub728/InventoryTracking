import { ProductForecastTab } from '@/components/products/product-forecast-tab';

interface PageProps {
  params: { id: string };
}

export default function ProductForecastPage({ params }: PageProps) {
  return <ProductForecastTab productId={params.id} />;
}
