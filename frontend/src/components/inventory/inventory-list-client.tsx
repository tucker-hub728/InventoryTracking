'use client';

import * as React from 'react';
import { ArrowDownUp, ArrowRightLeft, Plus } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { InventoryKPIs } from './inventory-kpis';
import { InventoryFilters } from './inventory-filters';
import { InventoryTable } from './inventory-table';
import { InventoryPagination } from './inventory-pagination';
import { NewItemDialog } from './new-item-dialog';
import { MovementWizard } from './movement-wizard';
import { TransferDialog } from './transfer-dialog';
import { useInventoryStore } from '@/stores/inventory.store';
import { usePermission } from '@/hooks/use-permission';
import { toast } from '@/components/ui/sonner';

/**
 * Inventory list page client.
 *
 * Pure shell — no API calls and no filtering logic of its own. The
 * ``useInventoryStore`` owns both filter state and the server data.
 * This component:
 *   1. Triggers a fetch on mount and whenever the *fetch-triggering*
 *      slice of filters changes.
 *   2. Renders the store's ``items`` (current page) + ``total``.
 *   3. Surfaces ``loading`` / ``loadError`` to the UI.
 *
 * Anything that needs to mutate filters or talk to the backend goes
 * through the store — components never call the API directly.
 */

// Transfer movement flow is hidden for now (frontend only). The dialog +
// handler stay wired; flip to true to re-enable the button.
const SHOW_TRANSFER = false;

// "Record movement" is hidden on the inventory list — movements are recorded
// from an item's detail page. The wizard stays wired; flip to re-enable.
const SHOW_RECORD_MOVEMENT = false;

export function InventoryListClient() {
  const [creating, setCreating] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [transferring, setTransferring] = React.useState(false);
  const canCreate = usePermission('inventory', 'create');
  const canSign = usePermission('inventory', 'sign');

  // Server data + actions from the store.
  const items = useInventoryStore((s) => s.items);
  const total = useInventoryStore((s) => s.total);
  const loading = useInventoryStore((s) => s.loading);
  const loadError = useInventoryStore((s) => s.loadError);
  const fetchItems = useInventoryStore((s) => s.fetch);

  // Filter state we react to. Listed separately (not as one object) so
  // Zustand's referential equality only re-runs the effect when one of
  // these *primitives* actually changes.
  const query = useInventoryStore((s) => s.query);
  const status = useInventoryStore((s) => s.status);
  const sortKey = useInventoryStore((s) => s.sortKey);
  const sortDir = useInventoryStore((s) => s.sortDir);
  const page = useInventoryStore((s) => s.page);
  const pageSize = useInventoryStore((s) => s.pageSize);

  // Refetch when anything the backend filters / sorts / paginates by
  // changes. The store's filter mutators are responsible for resetting
  // ``page`` to 1 on a query/category/status change so this effect
  // fires with the right offset.
  React.useEffect(() => {
    const ctrl = new AbortController();
    void fetchItems({ signal: ctrl.signal });
    return () => ctrl.abort();
  }, [fetchItems, query, status, sortKey, sortDir, page, pageSize]);

  // KPI tile inputs — until the movements module ships and we have a
  // ``/items/summary`` endpoint, derive what we can from the current
  // page and leave the rest at zero. Documented inside the component.
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const startIdx = (page - 1) * pageSize;

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle={
          loading && total === 0
            ? 'Loading inventory…'
            : `${total.toLocaleString()} items tracked`
        }
        actions={
          <>
            {canSign && (
              <>
                {SHOW_TRANSFER && (
                  <Button onClick={() => setTransferring(true)}>
                    <ArrowRightLeft size={14} /> Transfer
                  </Button>
                )}
                {SHOW_RECORD_MOVEMENT && (
                  <Button onClick={() => setPicking(true)}>
                    <ArrowDownUp size={14} /> Record movement
                  </Button>
                )}
              </>
            )}
            {canCreate && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={14} /> Add item
              </Button>
            )}
          </>
        }
      />

      <div className="px-6 py-5 sm:px-8">
        {/* <InventoryKPIs items={items} total={total} /> */}

        <InventoryFilters
          onExport={() =>
            toast.info('Export queued', { description: 'You will be notified when ready.' })
          }
        />

        <Card className="overflow-hidden">
          {loadError ? (
            <EmptyState
              title="Couldn't load inventory"
              hint={loadError}
              action={
                <Button onClick={() => void fetchItems()}>Retry</Button>
              }
            />
          ) : !loading && items.length === 0 && total === 0 ? (
            <EmptyState
              title="No items match"
              hint="Adjust filters or refine your search."
            />
          ) : (
            <div className="overflow-x-auto">
              <InventoryTable rows={items} />
            </div>
          )}
        </Card>

        <InventoryPagination
          total={total}
          startIdx={startIdx}
          rowsOnPage={items.length}
          pageCount={pageCount}
        />
      </div>

      <NewItemDialog open={creating} onOpenChange={setCreating} />
      <MovementWizard
        open={picking}
        onOpenChange={setPicking}
        onCompleted={() => void fetchItems()}
      />
      <TransferDialog
        open={transferring}
        onOpenChange={setTransferring}
        onCompleted={() => void fetchItems()}
      />
    </>
  );
}
