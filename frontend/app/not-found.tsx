import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-6">
      <div className="text-center">
        <div className="font-mono text-xs uppercase tracking-widest text-text-3">404</div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 max-w-sm text-sm text-text-2">
          The page you’re looking for doesn’t exist or has been moved.
        </p>
        <div className="mt-6">
          <Button asChild variant="primary">
            <Link href="/inventory/cr">Back to inventory</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
