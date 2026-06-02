'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { mockData } from '@/lib/mock-data';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

export function RecordMovementPicker({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState('');
  const debounced = useDebouncedValue(q, 120);

  const matches = React.useMemo(() => {
    const needle = debounced.trim().toLowerCase();
    const all = mockData.items;
    if (!needle) return all.slice(0, 60);
    return all
      .filter((it) =>
        `${it.id} ${it.desc} ${it.vendor}`.toLowerCase().includes(needle),
      )
      .slice(0, 60);
  }, [debounced]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Record movement</DialogTitle>
          <DialogDescription>
            Choose an item to record a movement against. You’ll be taken to its ledger.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Input
            icon={Search}
            autoFocus
            placeholder="Search by Item # or name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search items"
          />
          <ul
            role="listbox"
            className="max-h-[360px] overflow-y-auto rounded-md border border-border"
          >
            {matches.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-text-3">
                No matching items.
              </li>
            )}
            {matches.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    router.push(`/inventory/${it.id}?action=record`);
                  }}
                  className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-surface focus-visible:bg-surface focus-visible:outline-none"
                >
                  <span className="flex flex-col">
                    <span className="font-medium">{it.desc}</span>
                    <span className="font-mono text-xs text-text-3">
                      {it.id} · {it.vendor}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-xs text-text-2">Qty {it.qty}</span>
                </button>
              </li>
            ))}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
