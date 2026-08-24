"""The reorder trigger fires at ISSUE, not at consumption (PLN-002).

    "The reorder/consumption trigger for consumables shall fire at ISSUE (when
    stock is issued to a Kanban or use location), not at final consumption, so
    replenishment accounts for shipment lead time. Confirmed for low-dollar
    consumables; high-value materials (e.g., interleukins) are kitted rather
    than treated as consumables."
    — CellReady SRS Consolidated Amendment 9+10, v2 rev. 2026-08-18

**No code was written for PLN-002.** It is satisfied by construction: issue is
the only event that removes stock, so the threshold test in ``app.v_item_stock``
cannot fire anywhere else. This file exists because "satisfied by construction"
is exactly the kind of property that breaks silently — nothing in the codebase
*guards* it, and every way it could regress looks like a reasonable change:

  * making a kit reserve rather than debit at issue (so a draft could hold
    stock) would move the trigger later without touching planning;
  * adding a ``consumable_consumption`` movement type and debiting there would
    move the trigger to exactly the moment the requirement forbids;
  * filtering consumables out of the reorder query — plausible, since they
    follow "a separate calculation path" (REQ-2026-07-09-PLN-005) — would
    silence the consumable half of PLN-002 entirely.

None of those would fail an existing test. They fail these.

Both issue doors are covered, because "issued to a Kanban **or use location**"
is both of them: ``consumable_issue`` (low-dollar → Kanban) and ``kit_issue``
(high-value → production). The requirement's own carve-out — interleukins are
kitted, not consumed — is only safe if the kit door debits too.

The movement rows here are written directly rather than through the issue
endpoints. Those endpoints need an e-signature, a Kanban node, lot allocations
and a live API; the thing under test is the *timing of the debit*, and routing
around the ceremony keeps the test about that. The end-to-end path lives in
``smoke_consumables.py`` and ``smoke_kitting.py``.

Every test runs inside a transaction that is rolled back. ``app.stock_movements``
is append-only (``tg_stock_movements_no_delete``), so a committed fixture row
could not be cleaned up afterwards.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import NamedTuple

import pytest
import pytest_asyncio
from app.core.config import get_settings
from app.models.consumables import ConsumableIssue
from app.models.identity import User
from app.models.inventory import Item, ItemPrefix, ItemStock, ItemTier, StockMovement
from app.models.locations import LocationNode
from app.planning import repository as plan_repo
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

#: Stock the fixture item starts with, and the threshold it must stay above.
#: 150 against 100 leaves 50 of headroom — so a 60-unit issue is what tips it,
#: and a test that passed because the item was *already* low would be a false
#: positive.
STARTING_QTY = 150
THRESHOLD = Decimal("100")
ISSUE_QTY = 60


@pytest_asyncio.fixture
async def session_factory():
    """A sessionmaker on a throwaway engine, one per test.

    Same reasoning as ``test_stock_concurrency``: the app's global engine binds
    its pool to the first event loop it sees, and pytest-asyncio gives each test
    a fresh one.
    """
    engine = create_async_engine(str(get_settings().database_url), poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def stocked_item(session_factory):
    """Yield ``(session, make_item)`` inside a transaction that is rolled back.

    ``make_item`` builds an item with a live threshold and ``STARTING_QTY`` on
    the shelf, so each test can ask for the flavour it needs (consumable or
    not) without a second fixture.
    """
    async with session_factory() as s:
        # Seed anything missing rather than skipping. ``test_stock_concurrency``
        # reuses existing rows and skips when there are none, which is fine for
        # a lock test — but a PLN-002 guard that quietly skips on an empty
        # database guards nothing, and the test database IS empty. Everything
        # here is rolled back, so seeding costs nothing.
        user_id = (await s.execute(select(User.id).limit(1))).scalar_one_or_none()
        if user_id is None:
            user = User(
                cognito_sub=f"pln002-{uuid.uuid4().hex[:12]}",
                email=f"pln002-{uuid.uuid4().hex[:12]}@example.invalid",
                full_name="PLN-002 fixture",
                initials="PF",
                role="super_admin",
            )
            s.add(user)
            await s.flush()
            user_id = user.id

        prefix_id = (await s.execute(select(ItemPrefix.id).limit(1))).scalar_one_or_none()
        if prefix_id is None:
            tier = ItemTier(
                name=f"PLN-002 tier {uuid.uuid4().hex[:6]}",
                type="raw_material",
                tone="neutral",
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
            )
            s.add(tier)
            await s.flush()
            prefix = ItemPrefix(
                tier_id=tier.id,
                code=f"P{uuid.uuid4().hex[:4].upper()}",
                label="PLN-002 fixture",
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
            )
            s.add(prefix)
            await s.flush()
            prefix_id = prefix.id

        # An issue must name where it came from and where it went: the ledger's
        # ``ck_movements_locations`` requires both ends on consumable_issue and
        # both kit issue types. Two bare root nodes stand in for "a shelf" and
        # "the place it went" — the requirement is about the timing of the
        # debit, not about the shape of the tree.
        source_node = LocationNode(
            node_type="room",
            code=f"PLN2SRC{uuid.uuid4().hex[:6].upper()}",
            name="PLN-002 source",
            created_by_user_id=user_id,
        )
        dest_node = LocationNode(
            node_type="room",
            code=f"PLN2DST{uuid.uuid4().hex[:6].upper()}",
            name="PLN-002 destination",
            created_by_user_id=user_id,
        )
        s.add_all([source_node, dest_node])
        await s.flush()

        async def make_item(*, is_consumable: bool) -> Item:
            item = Item(
                prefix_id=prefix_id,
                # Random suffix: the number is unique within its prefix, and the
                # fixture must not collide with catalogue rows or with itself.
                sku_suffix=f"PLN2{uuid.uuid4().hex[:8]}",
                description="PLN-002 fixture",
                uom="Each",
                is_consumable=is_consumable,
                reorder_threshold=THRESHOLD,
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
            )
            s.add(item)
            await s.flush()
            s.add(
                StockMovement(
                    item_id=item.id,
                    movement_type="receipt",
                    qty_delta=STARTING_QTY,
                    qty_abs=STARTING_QTY,
                    performed_by_user_id=user_id,
                )
            )
            await s.flush()
            return item

        yield s, make_item, _Issuer(user_id, source_node.id, dest_node.id)
        # Never committed — the append-only ledger has no delete.
        await s.rollback()


async def _stock(s, item: Item):
    """Read the item's live numbers straight from ``app.v_item_stock``.

    Columns, not the ``ItemStock`` entity, and this matters: selecting the
    entity hands back the instance already in the session's identity map, so
    the second read returns the FIRST read's numbers and every assertion below
    passes against pre-issue stock. Selecting scalars bypasses the identity map
    and hits the view each time — which is the point, since the whole test is
    "did this number move".
    """
    row = (
        await s.execute(
            select(ItemStock.qty_available, ItemStock.status_code).where(
                ItemStock.item_id == item.id
            )
        )
    ).one_or_none()
    assert row is not None, "v_item_stock must have a row for every live item"
    return row


class _Issuer(NamedTuple):
    """Who posts the issue and between which nodes."""

    user_id: uuid.UUID
    source_node_id: uuid.UUID
    dest_node_id: uuid.UUID


async def _issue(s, item: Item, by: _Issuer, movement_type: str, qty: int = ISSUE_QTY) -> None:
    """Post an issue of ``qty`` — the debit the requirement is about.

    Negative ``qty_delta`` is the whole point: it is what makes the units leave
    *available* stock the instant the issue happens, which is what moves the
    reorder flag. Both real writers do exactly this — see
    ``consumables/repository.py`` (``qty_delta=-qty``) and
    ``kitting/routes.py::_move_to_production`` ("``qty_delta`` stays negative").
    """
    s.add(
        StockMovement(
            item_id=item.id,
            movement_type=movement_type,
            qty_delta=-qty,
            qty_abs=qty,
            from_location_node_id=by.source_node_id,
            to_location_node_id=by.dest_node_id,
            performed_by_user_id=by.user_id,
        )
    )
    await s.flush()


# ── The trigger moves at issue ─────────────────────────────────────────


class TestIssueMovesTheTrigger:
    """The whole requirement in two tests, one per issue door."""

    @pytest.mark.parametrize(
        "movement_type",
        ["consumable_issue", "kit_issue", "kit_additional_issue"],
        ids=["consumable-to-kanban", "kit-to-production", "kit-top-up"],
    )
    async def test_issue_drops_available_and_raises_the_flag(
        self, stocked_item, movement_type: str
    ) -> None:
        s, make_item, issuer = stocked_item
        # A consumable goes through the Kanban door; a kitted item cannot be a
        # consumable at all (a consumable is barred from every BOM), so the
        # flavour follows the door.
        item = await make_item(is_consumable=movement_type == "consumable_issue")

        before = await _stock(s, item)
        assert before.qty_available == STARTING_QTY
        assert before.status_code == "available", "fixture must start above the threshold"

        await _issue(s, item, issuer, movement_type)

        after = await _stock(s, item)
        # 150 - 60 = 90, which is under the 100 threshold.
        assert after.qty_available == STARTING_QTY - ISSUE_QTY
        assert after.status_code == "low_stock", (
            "issue must move the reorder flag immediately — PLN-002 forbids "
            "waiting for consumption"
        )

    async def test_the_item_appears_on_the_reorder_list_after_issue(
        self, stocked_item
    ) -> None:
        """The flag is not enough — planning must actually surface the row."""
        s, make_item, issuer = stocked_item
        item = await make_item(is_consumable=True)

        listed_before = {i.id for i, *_ in await plan_repo.list_reorder_rows(s, limit=200)}
        assert item.id not in listed_before

        await _issue(s, item, issuer, "consumable_issue")

        listed_after = {i.id for i, *_ in await plan_repo.list_reorder_rows(s, limit=200)}
        assert item.id in listed_after, "an issued-down item must reach the Reorder screen"

    async def test_a_kitted_item_reaches_the_same_list(self, stocked_item) -> None:
        """PLN-002's carve-out — interleukins are kitted, not consumed — only
        holds if the kit door lands on the same screen."""
        s, make_item, issuer = stocked_item
        item = await make_item(is_consumable=False)

        await _issue(s, item, issuer, "kit_issue")

        listed = {i.id for i, *_ in await plan_repo.list_reorder_rows(s, limit=200)}
        assert item.id in listed

    async def test_stock_still_on_the_shelf_does_not_warn(self, stocked_item) -> None:
        """The negative control. Without this, a query that returned every item
        would pass every test above."""
        s, make_item, issuer = stocked_item
        item = await make_item(is_consumable=True)

        # 30 out of 150 leaves 120 — still above the 100 threshold.
        await _issue(s, item, issuer, "consumable_issue", qty=30)

        assert (await _stock(s, item)).status_code == "available"
        listed = {i.id for i, *_ in await plan_repo.list_reorder_rows(s, limit=200)}
        assert item.id not in listed


# ── There is nowhere later for the trigger to fire ─────────────────────


class TestNoConsumptionEvent:
    """PLN-002's "not at final consumption" is guaranteed by absence: the
    ledger has no consumption event, so nothing later *can* fire."""

    def test_the_ledger_has_no_consumption_movement(self) -> None:
        from app.models.inventory import MOVEMENT_TYPES

        # Issue is terminal for a consumable's quantity (07-09 TRX-001). If a
        # consumption event is ever added, PLN-002 has to be re-argued: the
        # question becomes which of the two debits the stock, and the answer
        # must still be the issue.
        offenders = [m for m in MOVEMENT_TYPES if "consum" in m and m != "consumable_issue"]
        assert offenders == [], (
            f"new consumption-shaped movement type(s) {offenders} — PLN-002 requires "
            "the reorder trigger to stay on issue"
        )

    def test_the_wire_contract_matches_the_ledger(self) -> None:
        """``MovementType`` (API) and ``MOVEMENT_TYPES`` (DB CHECK) must agree.

        They have drifted before — omitting the kitting types from the schema
        made the ledger endpoint fail to serialise any kitted item. A movement
        the ledger can hold but the API cannot name is a debit the reorder
        screen would never learn about.
        """
        from typing import get_args

        from app.inventory.schemas import MovementType
        from app.models.inventory import MOVEMENT_TYPES

        assert set(get_args(MovementType)) == set(MOVEMENT_TYPES)

    def test_the_post_issue_register_holds_no_quantity(self) -> None:
        """``app.consumable_issues`` tracks expiry after issue, nothing else.

        Its ``disposition`` may be set to ``'consumed'``, which is the one thing
        in the schema that *looks* like a consumption trigger. It is not: the
        table has no quantity column and never touches the ledger, so wiring the
        reorder trigger to it would both fire at the wrong time and have no
        number to fire on.
        """
        columns = set(ConsumableIssue.__table__.columns.keys())
        assert not columns & {"qty", "quantity", "qty_delta", "used_qty"}, (
            "a quantity on the expiry register would invite a consumption-time "
            "trigger, which PLN-002 forbids"
        )


class TestArrivedStockSplitsTheList:
    """Material on site but not shelved must not read as "buy more" (REQ-004).

    An item can be below its threshold for two opposite reasons, and the screen
    has to tell them apart: nothing is coming (order it), or a delivery is
    sitting in the receiving bay (release it). Getting this wrong buys material
    that is already in the building.

    ``_covered_by_arrivals`` is the SQL that decides. It is asserted here on the
    compiled statement because seeding a real quarantined lot needs a purchase
    order, a receive event and a receipt line — the arithmetic is what matters,
    and it is a single clause a later edit could drop silently.
    """

    @staticmethod
    def _sql(*, awaiting: bool) -> str:
        from sqlalchemy import func, select
        from sqlalchemy.dialects import postgresql

        stmt = plan_repo._at_or_below(
            select(func.count()).select_from(Item).join(ItemStock, ItemStock.item_id == Item.id)
        )
        covered = plan_repo._covered_by_arrivals()
        stmt = stmt.where(covered if awaiting else ~covered)
        # ``literal_binds`` so the predicate's *values* are visible: without it
        # 'quarantine' renders as a bound parameter and an assertion on it would
        # pass against any release state at all.
        return str(
            stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
        )

    def test_both_groups_key_off_arrival(self) -> None:
        # Only quarantined, received material counts as "already here".
        for awaiting in (True, False):
            assert "release_state = 'quarantine'" in self._sql(awaiting=awaiting)

    def test_the_two_groups_are_complements(self) -> None:
        """Every at-or-below item lands in exactly one group.

        The order group is the release group's exact negation, so the two
        statements differ only by a wrapping ``NOT``. If they ever stop being
        complements an item could fall through both and vanish from the screen
        — the silent failure that matters most here.
        """
        order_where = self._sql(awaiting=False).split("WHERE", 1)[1]
        release_where = self._sql(awaiting=True).split("WHERE", 1)[1]
        assert "AND NOT (" in order_where
        assert "AND NOT (" not in release_where
        # Same predicate underneath. Compared by its parts rather than as one
        # string: the negated form nests differently, and asserting on exact SQL
        # text would fail on a harmless re-parenthesisation.
        gap = "app.items.reorder_threshold - app.v_item_stock.qty_available"
        for fragment in ("release_state = 'quarantine'", f">= {gap}", "> 0"):
            assert fragment in order_where, fragment
            assert fragment in release_where, fragment

    def test_an_item_exactly_on_its_threshold_is_not_called_arrived(self) -> None:
        """The zero-shortfall trap.

        An item sitting exactly on its threshold has a shortfall of zero, and
        ``0 >= 0`` is true — so without an explicit "something actually
        arrived" guard, every such item would be filed under "arrived, needs
        release" and rendered as "0 units to put away", while the real
        order-this signal went missing. Caught in review 2026-08-24.
        """
        release_sql = self._sql(awaiting=True)
        assert "> 0" in release_sql.split("WHERE", 1)[1], (
            "the release group must require that some material actually arrived, "
            "not merely that arrivals >= a zero shortfall"
        )

    def test_only_received_material_counts(self) -> None:
        """Manufactured output is quarantined too, but releasing it is a quality
        decision, not a put-away — and no amount of it means "do not order"."""
        assert "receipt_transaction_line_id IS NOT NULL" in self._sql(awaiting=True)

    def test_ordinary_on_order_quantity_is_still_not_netted_off(self) -> None:
        """The client's rule turns on ARRIVAL. Stock that is merely ordered may
        be late and must keep warning; only material physically on site moves an
        item out of the order group. A lot with no receipt behind it, or one
        already released onto a shelf, is not in this sum.
        """
        sql = self._sql(awaiting=True)
        assert "app.lots.release_state = 'quarantine'" in sql
        # The order group must NOT consult purchase-order quantities.
        assert "receipt_transaction_lines" not in self._sql(awaiting=False)


class TestOpenOrdersSplitTheList:
    """An item already on order must not sit under "raise a purchase order".

    Added after the client found every row on the order list already had an open
    PO covering it — one for 15,000 units against a shortfall of 4. The rule
    that on-order is never *subtracted* still stands (a late order must not go
    quiet); what changed is which heading the row appears under.
    """

    @staticmethod
    def _sql(group: str) -> str:
        from sqlalchemy import func, select
        from sqlalchemy.dialects import postgresql

        stmt = plan_repo._at_or_below(
            select(func.count()).select_from(Item).join(ItemStock, ItemStock.item_id == Item.id)
        ).where(plan_repo._group_filter(group))
        return str(
            stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
        )

    def test_the_order_group_excludes_anything_already_ordered(self) -> None:
        sql = self._sql("order")
        assert "receipt_transaction_lines" in sql, (
            "the to-order group must consult open purchase orders, or it will "
            "keep telling buyers to re-order what they already bought"
        )
        assert "cancelled" in sql, "a cancelled order must not count as coverage"

    def test_the_on_order_group_requires_an_actual_order(self) -> None:
        # Same zero-shortfall trap as the arrivals split: without "> 0", every
        # item sitting exactly on its threshold would be filed as "on order"
        # with nothing ordered.
        assert "> 0" in self._sql("on_order").split("WHERE", 1)[1]

    def test_arrived_stock_outranks_an_open_order(self) -> None:
        """An item can be part-delivered AND still on order. It belongs under
        the heading whose action is closest to done — receiving what is already
        on site beats chasing what is not."""
        on_order_sql = self._sql("on_order")
        # The on-order group explicitly excludes the arrived-covered ones.
        assert "NOT (" in on_order_sql
        assert "release_state = 'quarantine'" in on_order_sql

    def test_the_three_groups_are_disjoint_and_total(self) -> None:
        """Every at-or-below item lands in exactly one group.

        If the predicates stop partitioning cleanly an item can fall through
        all three and vanish from the screen — the silent failure that matters
        most, because the item is short and nobody is told.
        """
        order, on_order, awaiting = (self._sql(g) for g in ("order", "on_order", "awaiting"))
        # awaiting = A; on_order = NOT A AND B; order = NOT A AND NOT B.
        assert "NOT (" not in awaiting
        assert on_order.count("NOT (") == 1
        assert order.count("NOT (") == 2

    def test_on_order_quantity_is_converted_to_consume_units(self) -> None:
        """REQ-001: order lines count packs. Comparing 150 BOX against a
        threshold of 5 units would call a covered item uncovered."""
        assert "units_per_pack" in self._sql("on_order")


class TestConsumablesAreNotFilteredOut:
    """Consumables follow "a separate calculation path" (PLN-005), which makes
    excluding them from planning a tempting and wrong edit."""

    def test_the_reorder_query_does_not_filter_by_is_consumable(self) -> None:
        from sqlalchemy import func, select
        from sqlalchemy.dialects import postgresql

        stmt = plan_repo._at_or_below(
            select(func.count()).select_from(Item).join(ItemStock, ItemStock.item_id == Item.id)
        )
        assert "is_consumable" not in str(stmt.compile(dialect=postgresql.dialect()))
