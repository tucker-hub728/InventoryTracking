'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** A read-only link field with a copy-to-clipboard button. Used to hand over
 * one-time invite links (create + resend). */
export function CopyableLink({ value, id = 'copyable-link' }: { value: string; id?: string }) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success('Link copied');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy — select the link and copy manually.');
    }
  };

  return (
    <div className="flex items-stretch gap-2">
      <Input id={id} value={value} readOnly onFocus={(e) => e.target.select()} />
      <Button type="button" variant="primary" onClick={() => void copy()}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
        <span className="ml-1.5">{copied ? 'Copied' : 'Copy'}</span>
      </Button>
    </div>
  );
}
