'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { RouteTabs, type RouteTab } from '@/components/shared/route-tabs';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { usePermission } from '@/hooks/use-permission';

import { SupplierCreateDialog } from './supplier-create-dialog';

export const SUPPLIERS_TABS: readonly RouteTab[] = [
  { href: '/suppliers/active', label: 'Active' },
  { href: '/suppliers/deactivated', label: 'Deactivated' },
];

interface SuppliersShellContext {
  canManage: boolean;
  /** Bumped when a supplier is created, so the visible tab reloads. */
  createReload: number;
  openCreate: () => void;
}

const Ctx = React.createContext<SuppliersShellContext>({
  canManage: false,
  createReload: 0,
  openCreate: () => {},
});

export const useSuppliersShell = (): SuppliersShellContext => React.useContext(Ctx);

/**
 * Chrome shared by the Active and Deactivated supplier tabs, which are two
 * routes rather than two panels. Lives in ``app/(app)/suppliers/layout.tsx`` so
 * the header and tab strip survive navigation between them.
 *
 * The create dialog sits here (its button is in the header) and signals the
 * child route to refetch through context — the two are no longer siblings a
 * prop could connect.
 */
export function SuppliersShell({ children }: { children: React.ReactNode }) {
  const canManage = usePermission('inventory', 'create');
  const [creating, setCreating] = React.useState(false);
  const [createReload, setCreateReload] = React.useState(0);

  const ctx = React.useMemo(
    () => ({ canManage, createReload, openCreate: () => setCreating(true) }),
    [canManage, createReload],
  );

  return (
    <>
      <PageHeader
        title="Suppliers"
        subtitle="Master data for inventory item sourcing. Seeded from the workbook; admins add new suppliers here."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> Add supplier
            </Button>
          ) : undefined
        }
        tabs={<RouteTabs tabs={SUPPLIERS_TABS} label="Supplier status" />}
      />

      <div className="px-6 py-5 sm:px-8">
        <Ctx.Provider value={ctx}>{children}</Ctx.Provider>
      </div>

      <SupplierCreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(created) => {
          toast.success('Supplier added', { description: created.name });
          // A new supplier is always active, so it lands on the Active tab —
          // refetch rather than splice, so it appears in name order on the
          // correct page instead of being pinned to whichever one is open.
          setCreateReload((n) => n + 1);
        }}
      />
    </>
  );
}
