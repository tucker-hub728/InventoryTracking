"""The per-customer shipment history reads (CUST-001 / CUST-003).

    "Customers shall be maintained in a customer list ... CellReady may be its
    own customer."  — CUST-001
    "The finished-good/shipment ledger shall be read-only, showing made and
    shipped states."  — CUST-003

The page behind these reads answers "how much of what have we sent them, and
when". What is worth guarding is not that the SQL runs — it is the two places
where the obvious implementation is subtly wrong:

1. **A shipment is not a ledger row.** A multi-source ship posts one movement per
   source lot inside a single transaction. Counting rows would report "3
   shipments" for one signed action, and paging on rows would split one shipment
   across two pages. The grouping key is ``performed_at``, which Postgres sets to
   the TRANSACTION timestamp — so the rows of one ship tie exactly and the rows
   of two ships cannot.

2. **Only shipments, only this customer.** The customer filter alone is not
   enough: ``customer_id`` is a column on the whole ledger, and any future
   movement type that names a customer would silently join these totals if the
   ``movement_type`` predicate were dropped.

Both regressions look like reasonable changes and neither would fail an existing
test, which is why they are pinned here.

The movement rows are written directly rather than through ``POST /shipments``:
that endpoint needs an e-signature, real lots, allocations and a live API, and
the thing under test is how the READS fold those rows back up. The end-to-end
write path lives in ``smoke_shipments.py``.

Every test runs inside a transaction that is rolled back — ``app.stock_movements``
is append-only (``tg_stock_movements_no_delete``), so a committed fixture row
could never be cleaned up afterwards.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from app.core.config import get_settings
from app.models.identity import User
from app.models.inventory import Item, ItemPrefix, ItemTier, StockMovement
from app.models.locations import LocationNode
from app.models.products import Customer
from app.shipments import repository as ship_repo
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

#: Three instants, so "newest first" and "one event per instant" are both
#: testable. Explicit rather than ``now()``: the grouping is BY this value, and a
#: fixture that let the database choose could not tell one shipment from three.
T1 = datetime(2026, 8, 20, 9, 0, tzinfo=UTC)
T2 = datetime(2026, 8, 21, 9, 0, tzinfo=UTC)
T3 = datetime(2026, 8, 22, 9, 0, tzinfo=UTC)


@pytest_asyncio.fixture
async def session_factory():
    """A sessionmaker on a throwaway engine, one per test.

    Same reasoning as ``test_planning_issue_trigger``: the app's global engine
    binds its pool to the first event loop it sees, and pytest-asyncio gives each
    test a fresh one.
    """
    engine = create_async_engine(str(get_settings().database_url), poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def shipped(session_factory):
    """Yield ``(session, customer, other_customer, item_a, item_b)`` with a
    history already written, inside a transaction that is rolled back.

    The history is deliberately lopsided so every assertion below has something
    to bite on:

    ==========  ======  =====  ==========================================
    instant     item    units  note
    ==========  ======  =====  ==========================================
    T1          A       10     one lot — the simple case
    T2          A       30     THREE lots in one transaction — one shipment
    T3          B       5      a second item, so the rollup has two rows
    T2          A       99     a DIFFERENT customer, at a colliding instant
    T3          A       77     a transfer, not a shipment
    ==========  ======  =====  ==========================================

    The last two rows are the negative controls: the colliding instant would be
    folded into this customer's T2 shipment if the second query dropped its
    customer predicate, and the transfer would inflate every total if the
    movement-type predicate were dropped.
    """
    async with session_factory() as s:
        # Seed anything missing rather than skipping: a guard test that quietly
        # skips on an empty database guards nothing, and the test database IS
        # empty. Everything here is rolled back, so seeding costs nothing.
        user_id = (await s.execute(select(User.id).limit(1))).scalar_one_or_none()
        if user_id is None:
            user = User(
                cognito_sub=f"cust-hist-{uuid.uuid4().hex[:12]}",
                email=f"cust-hist-{uuid.uuid4().hex[:12]}@example.invalid",
                full_name="CUST-001 fixture",
                initials="CF",
                role="super_admin",
            )
            s.add(user)
            await s.flush()
            user_id = user.id

        prefix_id = (await s.execute(select(ItemPrefix.id).limit(1))).scalar_one_or_none()
        if prefix_id is None:
            tier = ItemTier(
                name=f"CUST-001 tier {uuid.uuid4().hex[:6]}",
                type="finished_good",
                tone="neutral",
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
            )
            s.add(tier)
            await s.flush()
            prefix = ItemPrefix(
                tier_id=tier.id,
                code=f"C{uuid.uuid4().hex[:4].upper()}",
                label="CUST-001 fixture",
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
            )
            s.add(prefix)
            await s.flush()
            prefix_id = prefix.id

        # A shipment leaves the system: ``ck_movements_locations`` requires a
        # FROM and no TO. One bare node stands in for "the shelf it left".
        source = LocationNode(
            node_type="room",
            code=f"CUSTSRC{uuid.uuid4().hex[:6].upper()}",
            name="CUST-001 source",
            created_by_user_id=user_id,
        )
        s.add(source)
        await s.flush()

        def _customer(label: str) -> Customer:
            return Customer(
                name=f"{label} {uuid.uuid4().hex[:8]}",
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
            )

        customer = _customer("CUST-001 fixture")
        other = _customer("CUST-001 other")
        s.add_all([customer, other])

        def _item(label: str) -> Item:
            return Item(
                prefix_id=prefix_id,
                # Random suffix: the number is unique within its prefix, and the
                # fixture must not collide with catalogue rows or with itself.
                sku_suffix=f"CUST{uuid.uuid4().hex[:8]}",
                description=label,
                uom="Each",
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
            )

        item_a = _item("CUST-001 fixture item A")
        item_b = _item("CUST-001 fixture item B")
        s.add_all([item_a, item_b])
        await s.flush()

        def _movement(*, item, qty, at, customer_id, movement_type="customer_shipment", ref=None):
            return StockMovement(
                item_id=item.id,
                movement_type=movement_type,
                # Unit-OUT: the delta is negative and ``qty_abs`` is the
                # magnitude. Everything the reads report comes from qty_abs.
                qty_delta=-qty,
                qty_abs=qty,
                from_location_node_id=source.id,
                from_location_path="CUST-001 source",
                customer_id=customer_id,
                reference_number=ref,
                performed_by_user_id=user_id,
                performed_at=at,
            )

        s.add_all(
            [
                _movement(item=item_a, qty=10, at=T1, customer_id=customer.id, ref="SO-1"),
                # One shipment, three lots — all at T2.
                _movement(item=item_a, qty=12, at=T2, customer_id=customer.id, ref="SO-2"),
                _movement(item=item_a, qty=10, at=T2, customer_id=customer.id, ref="SO-2"),
                _movement(item=item_a, qty=8, at=T2, customer_id=customer.id, ref="SO-2"),
                _movement(item=item_b, qty=5, at=T3, customer_id=customer.id),
                # Negative control 1: another customer, colliding instant.
                _movement(item=item_a, qty=99, at=T2, customer_id=other.id),
                # Negative control 2: not a shipment.
                _movement(
                    item=item_a,
                    qty=77,
                    at=T3,
                    customer_id=customer.id,
                    movement_type="transfer_out",
                ),
            ]
        )
        await s.flush()

        yield s, customer, other, item_a, item_b
        # Never committed — the append-only ledger has no delete.
        await s.rollback()


@pytest.mark.anyio
async def test_multi_lot_ship_is_one_event(shipped):
    """Three ledger rows written in one transaction are ONE shipment.

    The regression this catches is the obvious implementation: list the movements
    and call each one a shipment. It would report five shipments where an
    operator signed three, and 30 units as three separate sends.
    """
    s, customer, _other, _a, _b = shipped

    events = await ship_repo.list_shipment_events_for_customer(s, customer_id=customer.id)
    at_t2 = [e for e in events if e[0] == T2]
    assert len(at_t2) == 1, "the three rows of one ship must fold into one event"

    _at, movements = at_t2[0]
    assert len(movements) == 3, "every source lot must survive as a line"
    assert sum(m.qty_abs for m in movements) == 30
    # The magnitude, not the stored delta: "-30 units shipped" reads as a
    # correction rather than a quantity.
    assert all(m.qty_abs > 0 for m in movements)


@pytest.mark.anyio
async def test_events_are_newest_first_and_scoped(shipped):
    """Three events, newest first — and neither negative control appears."""
    s, customer, _other, _a, _b = shipped

    events = await ship_repo.list_shipment_events_for_customer(s, customer_id=customer.id)
    instants = [at for at, _ in events]
    assert instants == [T3, T2, T1]

    # The other customer's 99 units share T2. If the second query dropped its
    # customer predicate they would be folded into this customer's shipment.
    _at, t2_rows = next((at, rows) for at, rows in events if at == T2)
    assert sum(m.qty_abs for m in t2_rows) == 30, "another customer's row leaked into this event"

    # The T3 transfer_out is not a shipment. If the movement-type predicate were
    # dropped it would appear as a second line on the T3 event.
    _at3, t3_rows = next((at, rows) for at, rows in events if at == T3)
    assert [m.qty_abs for m in t3_rows] == [5], "a non-shipment movement leaked in"


@pytest.mark.anyio
async def test_totals_count_shipments_not_rows(shipped):
    """``shipment_count`` is signed ship actions; ``total_qty`` is every unit."""
    s, customer, _other, _a, _b = shipped

    count, qty, items, last_at = await ship_repo.shipped_totals_for_customer(
        s, customer_id=customer.id
    )
    assert count == 3, "five ledger rows, three signed shipments"
    assert qty == 45, "10 + 30 + 5, and neither control row"
    assert items == 2
    assert last_at == T3

    assert await ship_repo.shipment_event_count(s, customer_id=customer.id) == 3


@pytest.mark.anyio
async def test_by_item_rollup_is_ordered_by_quantity(shipped):
    """The rollup answers "what do we send them", biggest first."""
    s, customer, _other, item_a, item_b = shipped

    rows = await ship_repo.shipped_by_item_for_customer(s, customer_id=customer.id)
    assert [r[1] for r in rows] == [item_a.id, item_b.id], "biggest total must lead"

    (_item, _id, qty_a, ships_a, last_a) = rows[0]
    assert qty_a == 40, "10 at T1 + 30 at T2 — the transfer is not a shipment"
    assert ships_a == 2, "two signed shipments of item A, not four ledger rows"
    assert last_a == T2

    (_item_b, _id_b, qty_b, ships_b, _last_b) = rows[1]
    assert (qty_b, ships_b) == (5, 1)


@pytest.mark.anyio
async def test_paging_walks_events(shipped):
    """Limit and offset move a page of EVENTS, never a page of rows.

    Paging on rows would put two lines of the T2 shipment on page 1 and the third
    on page 2 — the same shipment shown twice, with the wrong quantity both
    times.
    """
    s, customer, _other, _a, _b = shipped

    page1 = await ship_repo.list_shipment_events_for_customer(s, customer_id=customer.id, limit=2)
    assert [at for at, _ in page1] == [T3, T2]
    # The whole shipment travels with its event.
    assert len(page1[1][1]) == 3

    page2 = await ship_repo.list_shipment_events_for_customer(
        s, customer_id=customer.id, limit=2, offset=2
    )
    assert [at for at, _ in page2] == [T1]


@pytest.mark.anyio
async def test_summary_by_customer_separates_customers(shipped):
    """One grouped query, one row per customer — and no crosstalk."""
    s, customer, other, _a, _b = shipped

    totals = await ship_repo.shipped_totals_by_customer(s)
    assert totals[customer.id] == (3, 45, T3)
    # The other customer has exactly its own single 99-unit shipment.
    assert totals[other.id] == (1, 99, T2)


@pytest.mark.anyio
async def test_customer_with_no_shipments_is_absent_not_zeroed(shipped):
    """A never-shipped-to customer is ABSENT from the summary, not zeroed.

    The list renders its dash from the gap. Returning a zero row instead would
    make "never shipped to" indistinguishable from a customer whose history
    exists, which is a real difference to anyone reading the page.
    """
    s, _customer, _other, _a, _b = shipped

    fresh = Customer(
        name=f"CUST-001 untouched {uuid.uuid4().hex[:8]}",
        created_by_user_id=(await s.execute(select(User.id).limit(1))).scalar_one(),
        updated_by_user_id=(await s.execute(select(User.id).limit(1))).scalar_one(),
    )
    s.add(fresh)
    await s.flush()

    totals = await ship_repo.shipped_totals_by_customer(s)
    assert fresh.id not in totals

    # The per-customer reads still answer, with zeroes rather than an exception:
    # the customer page must render for a customer nothing has been sent to.
    assert await ship_repo.shipped_totals_for_customer(s, customer_id=fresh.id) == (0, 0, 0, None)
    assert await ship_repo.shipped_by_item_for_customer(s, customer_id=fresh.id) == []
    assert await ship_repo.list_shipment_events_for_customer(s, customer_id=fresh.id) == []
