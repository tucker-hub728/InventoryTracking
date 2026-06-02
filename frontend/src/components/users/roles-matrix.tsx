'use client';

import * as React from 'react';
import { Edit3 } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Role } from '@/types/auth';

const GROUPS = [
  {
    id: 'inventory' as const,
    label: 'Inventory',
    perms: [
      { key: 'view', label: 'View items & ledger' },
      { key: 'create', label: 'Create new items' },
      { key: 'edit', label: 'Edit item details' },
      { key: 'delete', label: 'Delete items' },
      { key: 'sign', label: 'Electronically sign transactions' },
    ],
  },
  {
    id: 'users' as const,
    label: 'User management',
    perms: [
      { key: 'view', label: 'View users list' },
      { key: 'create', label: 'Invite users' },
      { key: 'edit', label: 'Edit roles & permissions' },
      { key: 'delete', label: 'Suspend or delete users' },
    ],
  },
  {
    id: 'audit' as const,
    label: 'Audit & compliance',
    perms: [
      { key: 'view', label: 'View audit log' },
      { key: 'export', label: 'Export audit records' },
    ],
  },
];

export function RolesMatrix({ roles }: { roles: Role[] }) {
  const [activeId, setActiveId] = React.useState(roles[0]?.id);
  const active = roles.find((r) => r.id === activeId);

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Card className="overflow-hidden p-0">
        <ul role="tablist" aria-orientation="vertical">
          {roles.map((r, i) => (
            <li key={r.id}>
              <button
                role="tab"
                aria-selected={activeId === r.id}
                onClick={() => setActiveId(r.id)}
                className={cn(
                  'block w-full border-l-2 border-transparent p-4 text-left transition-colors',
                  i > 0 && 'border-t border-t-border',
                  activeId === r.id
                    ? 'border-l-text bg-surface-2'
                    : 'hover:bg-surface',
                )}
              >
                <div className="text-sm font-medium">{r.name}</div>
                <div className="mt-0.5 text-xs text-text-3">{r.userCount} users</div>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {active && (
        <Card className="overflow-hidden p-0">
          <div className="flex items-start justify-between gap-4 border-b border-border p-5">
            <div>
              <div className="text-base font-semibold">{active.name}</div>
              <p className="mt-1 max-w-prose text-sm text-text-2">{active.description}</p>
            </div>
            <Button size="sm">
              <Edit3 size={13} /> Edit role
            </Button>
          </div>

          <div className="divide-y divide-border">
            {GROUPS.map((g) => (
              <section key={g.id} className="p-5">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-3">
                  {g.label}
                </h3>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {g.perms.map((p) => {
                    const allowed = Boolean(
                      (active.perms[g.id] as unknown as Record<string, boolean>)[p.key],
                    );
                    return (
                      <li
                        key={p.key}
                        className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm"
                      >
                        <span>{p.label}</span>
                        {allowed ? (
                          <Badge tone="success" dot>
                            Allowed
                          </Badge>
                        ) : (
                          <Badge tone="neutral">Denied</Badge>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
