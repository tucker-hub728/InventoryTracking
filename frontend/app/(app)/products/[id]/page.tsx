import { redirect } from 'next/navigation';

interface PageProps {
  params: { id: string };
}

/** The product detail index has no content of its own — default to Materials. */
export default function ProductDetailIndexPage({ params }: PageProps) {
  redirect(`/products/${params.id}/material`);
}
