'use client';

import * as React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface State {
  error: Error | null;
}

interface Props {
  children: React.ReactNode;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

/**
 * Generic error boundary. Wrap feature subtrees so a render failure in one
 * page doesn't crash the whole shell. Pair with Next.js's error.tsx route
 * boundaries for the route-level story.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.error('[ErrorBoundary]', error, info);
    }
  }

  reset = (): void => this.setState({ error: null });

  override render(): React.ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return <DefaultErrorFallback error={this.state.error} reset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-lg border border-danger/30 bg-danger-soft p-8 text-center"
    >
      <AlertTriangle className="size-8 text-danger" aria-hidden />
      <div>
        <div className="text-base font-semibold text-text">Something went wrong</div>
        <div className="mt-1 text-sm text-text-2">
          {error.message || 'An unexpected error occurred.'}
        </div>
      </div>
      <Button variant="primary" size="sm" onClick={reset}>
        <RefreshCw className="size-3.5" /> Try again
      </Button>
    </div>
  );
}
