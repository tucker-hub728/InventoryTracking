"""The Kanban restock loop, and the stock that must never reappear (KAN-001).

    "Kanban locations shall hold area consumables in production/lab areas; on a
    restock request, the operator acknowledges consumption (marks the depleted
    quantity consumed) and reissues replenishment, keeping inventory accurate
    without per-unit tracking inside the Kanban."
    — CellReady SRS Consolidated Amendment 9+10, 2026-08-13

Two things are guarded here.

**A Kanban holds no balance.** An issue to one is a single unit-out row
and the quantity is gone; the restock loop on top of it — request, acknowledge,
reissue — is a record, and only the reissue touches stock.

**Stock at a Kanban stays invisible to every picker.** Every "available stock"
query filtered floor stock with ``flat_category != 'production'``, and a
Kanban's own ``flat_category`` is NULL — the category sits on its *parent*
area. So that filter alone lets Kanban rows straight through, and any
allocation standing at a bin would be offered as issuable stock in stores and
could be spent a second time. ``kit_repo.not_floor_stock`` is what closes it.

The fixture places an allocation at a Kanban ON PURPOSE, even though no current
code path creates one: it is the state a database lands in the moment somebody
makes a Kanban a storage node, which was tried once and reversed. The filter has
to hold before that mistake, not after it.

Tests run against the repository QUERIES rather than the endpoints because that
is where the property lives — an endpoint test would pass just as well against
a picker that had quietly re-derived the old one-line filter.

The timing half — that the debit happens at issue (PLN-002) — lives in
``test_planning_issue_trigger.py``.

Every test runs in a transaction that is rolled back; ``app.stock_movements`` is
append-only, so committed fixture rows could not be cleaned up.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest_asyncio
from app.consumables import repository as cons_repo
from app.core.config import get_settings
from app.exports import repository as exp_repo
from app.kitting import repository as kit_repo
from app.models.identity import User
from app.models.inventory import Item, ItemPrefix, ItemTier, Lot
from app.models.locations import (
    KANBAN_NODE_TYPE,
    STORAGE_NODE_TYPES,
    LocationNode,
    LotAllocation,
    can_store,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

QTY_IN_STORES = 100
QTY_IN_BIN = 40


@pytest_asyncio.fixture
async def session_factory():
    engine = create_async_engine(str(get_settings().database_url), poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def stocked_bin(session_factory):
    """An item with stock in TWO places: a warehouse shelf and a Kanban.

    The Kanban allocation is deliberately impossible to create through the app
    today — see the module docstring. It reproduces what kan01 left behind, so
    the filters can be tested against the state that actually exists in the
    wild rather than against one the code would happily produce.
    """
    async with session_factory() as s:
        user_id = (await s.execute(select(User.id).limit(1))).scalar_one_or_none()
        if user_id is None:
            user = User(
                cognito_sub=f"kan001-{uuid.uuid4().hex[:12]}",
                email=f"kan001-{uuid.uuid4().hex[:12]}@example.invalid",
                full_name="KAN-001 fixture",
                initials="KF",
                role="super_admin",
            )
            s.add(user)
            await s.flush()
            user_id = user.id

        prefix_id = (await s.execute(select(ItemPrefix.id).limit(1))).scalar_one_or_none()
        if prefix_id is None:
            tier = ItemTier(
                name=f"KAN-001 tier {uuid.uuid4().hex[:6]}",
                type="raw_material",
                tone="neutral",
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
            )
            s.add(tier)
            await s.flush()
            prefix = ItemPrefix(
                tier_id=tier.id,
                code=f"K{uuid.uuid4().hex[:4].upper()}",
                label="KAN-001 fixture",
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
            )
            s.add(prefix)
            await s.flush()
            prefix_id = prefix.id

        # Stores: a warehouse shelf inside a room. Floor: a Kanban inside a
        # production area. The parentage is not decoration — the Kanban's NULL
        # flat_category is exactly the thing under test.
        room = LocationNode(
            node_type="room",
            code=f"KANROOM{uuid.uuid4().hex[:5].upper()}",
            name="KAN-001 room",
            created_by_user_id=user_id,
        )
        area = LocationNode(
            node_type="flat",
            flat_category="production",
            code=f"KANAREA{uuid.uuid4().hex[:5].upper()}",
            name="KAN-001 area",
            created_by_user_id=user_id,
        )
        s.add_all([room, area])
        await s.flush()
        warehouse = LocationNode(
            node_type="warehouse",
            parent_id=room.id,
            code=f"KANWH{uuid.uuid4().hex[:5].upper()}",
            name="KAN-001 warehouse",
            created_by_user_id=user_id,
        )
        s.add(warehouse)
        await s.flush()
        shelf = LocationNode(
            node_type="shelf",
            parent_id=warehouse.id,
            code=f"KANSH{uuid.uuid4().hex[:5].upper()}",
            name="KAN-001 shelf",
            created_by_user_id=user_id,
        )
        kanban = LocationNode(
            node_type=KANBAN_NODE_TYPE,
            parent_id=area.id,
            code=f"KAN{uuid.uuid4().hex[:6].upper()}",
            name="KAN-001 Kanban",
            created_by_user_id=user_id,
        )
        s.add_all([shelf, kanban])
        await s.flush()

        item = Item(
            prefix_id=prefix_id,
            sku_suffix=f"KAN{uuid.uuid4().hex[:8]}",
            description="KAN-001 fixture",
            uom="Each",
            is_consumable=True,
            reorder_threshold=Decimal("0"),
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
        )
        s.add(item)
        await s.flush()
        lot = Lot(
            item_id=item.id,
            lot_number=f"KAN-{uuid.uuid4().hex[:10]}",
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
        )
        s.add(lot)
        await s.flush()
        s.add_all(
            [
                LotAllocation(
                    lot_id=lot.id,
                    location_node_id=shelf.id,
                    qty=Decimal(QTY_IN_STORES),
                    created_by_user_id=user_id,
                ),
                LotAllocation(
                    lot_id=lot.id,
                    location_node_id=kanban.id,
                    qty=Decimal(QTY_IN_BIN),
                    created_by_user_id=user_id,
                ),
            ]
        )
        await s.flush()

        yield s, item, lot, shelf, kanban, user_id
        await s.rollback()


class TestKanbanHoldsNoBalance:
    """A Kanban is an ADDRESS, not a place that holds stock.

    One line of config, which is exactly why it needs a test: adding ``kanban``
    back to ``STORAGE_NODE_TYPES`` is a one-word change that turns every issue
    into a move — see the kan01 migration docstring.
    """

    def test_a_kanban_is_not_a_storage_node(self) -> None:
        assert KANBAN_NODE_TYPE not in STORAGE_NODE_TYPES
        assert can_store(KANBAN_NODE_TYPE) is False

    def test_the_ordinary_storage_nodes_are_unaffected(self) -> None:
        """The negative control. Without it, a ``can_store`` that returned False
        for everything would pass the test above."""
        for node_type in ("box", "sub_location", "shelf"):
            assert can_store(node_type) is True


class TestKanbanStockIsNotAvailableToPickers:
    """The double-spend guard. One test per query that feeds a picker."""

    async def test_kit_issue_picker_does_not_offer_kanban_stock(self, stocked_bin) -> None:
        s, item, lot, shelf, kanban, _ = stocked_bin
        rows = (await kit_repo.item_stock_by_node_lot(s, {item.id})).get(item.id, [])
        nodes = {node_id: qty for *_, node_id, qty in rows}

        assert shelf.id in nodes, "stores stock must still be issuable"
        assert nodes[shelf.id] == QTY_IN_STORES
        assert kanban.id not in nodes, (
            "the Kanban's stock is on the production floor — offering it as an "
            "issue source would let the same units be spent twice"
        )

    async def test_node_level_stock_query_does_not_offer_kanban_stock(
        self, stocked_bin
    ) -> None:
        s, item, lot, shelf, kanban, _ = stocked_bin
        by_node = (await kit_repo.item_stock_by_node(s, {item.id})).get(item.id, {})

        assert by_node.get(shelf.id) == QTY_IN_STORES
        assert kanban.id not in by_node

    async def test_finance_export_does_not_count_kanban_stock(self, stocked_bin) -> None:
        """Held deliberately — see the comment on the predicate in
        ``exports/repository.py``. Asserted so the hold is a decision on the
        record rather than something nobody noticed."""
        s, item, lot, shelf, kanban, _ = stocked_bin
        rows = (await exp_repo.allocation_rows_by_item(s, [item.id])).get(item.id, [])
        nodes = {r.location_node_id for r in rows}

        assert shelf.id in nodes
        assert kanban.id not in nodes


class TestRestockRequestLifecycle:
    """One open request per (bin, item), and closing is all-or-nothing."""

    async def test_one_open_request_per_bin_and_item(self, stocked_bin) -> None:
        s, item, lot, shelf, kanban, user_id = stocked_bin
        assert (
            await cons_repo.open_request_for(s, kanban_node_id=kanban.id, item_id=item.id)
            is None
        )
        req = await cons_repo.create_restock_request(
            s,
            kanban_node_id=kanban.id,
            item_id=item.id,
            requested_qty=25,
            note="down to the last box",
            requested_by_user_id=user_id,
        )
        found = await cons_repo.open_request_for(
            s, kanban_node_id=kanban.id, item_id=item.id
        )
        assert found is not None and found.id == req.id

    async def test_closing_frees_the_slot_for_the_next_one(self, stocked_bin) -> None:
        """The unique index is PARTIAL — history accumulates, only the open row
        is exclusive. A bin that is restocked every week would otherwise be
        blocked forever by its first request."""
        s, item, lot, shelf, kanban, user_id = stocked_bin
        req = await cons_repo.create_restock_request(
            s,
            kanban_node_id=kanban.id,
            item_id=item.id,
            requested_qty=None,
            note=None,
            requested_by_user_id=user_id,
        )
        await cons_repo.close_restock_request(
            s, request=req, state="cancelled", user_id=user_id
        )
        assert req.closed_at is not None
        assert (
            await cons_repo.open_request_for(s, kanban_node_id=kanban.id, item_id=item.id)
            is None
        )
        # And a second request is now allowed — the index no longer sees the
        # closed one.
        again = await cons_repo.create_restock_request(
            s,
            kanban_node_id=kanban.id,
            item_id=item.id,
            requested_qty=10,
            note=None,
            requested_by_user_id=user_id,
        )
        assert again.id != req.id

    async def test_a_quantity_is_optional(self, stocked_bin) -> None:
        """"We're low" is a legitimate request — an operator who has not counted
        must not be forced to invent a number."""
        s, item, lot, shelf, kanban, user_id = stocked_bin
        req = await cons_repo.create_restock_request(
            s,
            kanban_node_id=kanban.id,
            item_id=item.id,
            requested_qty=None,
            note=None,
            requested_by_user_id=user_id,
        )
        assert req.requested_qty is None and req.state == "open"
