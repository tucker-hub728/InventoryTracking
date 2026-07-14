'use client';

import * as React from 'react';
import { ShieldCheck, Lock, Database } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useUIStore } from '@/stores/ui.store';
import { siteConfig } from '@/config/site';
import { cn } from '@/lib/utils';

/**
 * Two-column or centered auth shell. Variant is driven by the UI store
 * (tweaks panel) — split shows the security-context grid on the right,
 * centered renders the form in a single card.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  const variant = useUIStore((s) => s.login);
  const hydrated = useUIStore((s) => s.hydrated);
  const layout = hydrated ? variant : 'split';

  if (layout === 'centered') {
    return (
      <div className="grid min-h-screen place-items-center bg-bg px-4">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_30%,var(--accent-soft)_0%,transparent_60%)]" />
        <div className="w-full max-w-md rounded-lg border border-border bg-bg-elev p-8 shadow-elev-md">
          <BrandBlock />
          <div className="mt-6">{children}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex items-center justify-center bg-bg px-6 py-10 sm:px-10">
        <div className="w-full max-w-sm">
          <BrandBlock />
          <div className="mt-8">{children}</div>
        </div>
      </div>
      <div className="hidden flex-col justify-center gap-8 border-l border-border bg-surface px-10 py-12 lg:flex">
        <SecurityContextGrid />
      </div>
    </div>
  );
}

function BrandBlock() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-7 place-items-center rounded bg-text font-mono text-sm font-semibold text-bg">
        {siteConfig.shortName.charAt(0)}
      </div>
      <div>
        <div className="text-base font-semibold tracking-tight">{siteConfig.shortName}</div>
        <div className="text-xs text-text-3">{siteConfig.name}</div>
      </div>
    </div>
  );
}

function SecurityContextGrid() {
  const cards: Array<{ icon: LucideIcon; title: string; body: string }> = [
    {
      icon: ShieldCheck,
      title: '21 CFR Part 11',
      body: 'Audit-grade electronic signatures, immutable logs, and role-restricted controls for every transaction.',
    },
    {
      icon: Lock,
      title: 'Encrypted at rest',
      body: 'AES-256 for data at rest, TLS 1.3 for data in transit. Session keys rotate every 30 days.',
    },
    {
      icon: Database,
      title: 'Disaster recovery',
      body: 'Cross-region snapshots with 15-minute RPO and 1-hour RTO targets, exercised quarterly.',
    },
  ];
  return (
    <>
      <div className="max-w-md">
        <div className="text-xs font-semibold uppercase tracking-widest text-text-3">
          Compliance environment
        </div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">
          Built for regulated cell-therapy operations
        </h2>
        <p className="mt-2 text-sm text-text-2">
          Every action below is logged, attributed, and signable. Use only your personal credentials.
        </p>
      </div>
      <ul className="grid max-w-md gap-3">
        {cards.map((c) => (
          <li
            key={c.title}
            className={cn(
              'flex gap-3 rounded-md border border-border bg-bg-elev p-4 shadow-elev-sm',
            )}
          >
            <c.icon className="size-4 shrink-0 text-accent" aria-hidden />
            <div>
              <div className="text-sm font-medium">{c.title}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-text-2">{c.body}</div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
