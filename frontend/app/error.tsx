'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.error('[app error]', error);
    }
  }, [error]);

  return (
    <div className="grid min-h-screen place-items-center bg-bg px-6">
      <div className="max-w-md text-center">
        <AlertTriangle className="mx-auto size-8 text-danger" aria-hidden />
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-2 text-sm text-text-2">{error.message || 'Unexpected error.'}</p>
        <div className="mt-6">
          <Button variant="primary" onClick={reset}>
            <RefreshCw className="size-3.5" /> Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
