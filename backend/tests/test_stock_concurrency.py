"""Concurrency tests for stock movement (VR-004).

These are the tests that make the fix meaningful. A unit test that calls
``reduce_allocation`` once proves nothing about a lost update — the bug only
appears when two transactions overlap, so these run genuinely concurrent
sessions against the real database and assert on the arithmetic afterwards.

Under the OLD code (``allocation.qty = allocation.qty - qty`` in Python) the
first test FAILS: both callers read 5, both write 2, and six units leave a
box that held five. That is the regression being guarded.
"""

from __future__ import annotations

import asyncio
import uuid
from decimal import Decimal

import pytest
import pytest_asyncio
from app.core.config import get_settings
from app.core.exceptions import ConflictError
from app.locations import repository as loc_repo
from app.models.inventory import Item, Lot
from app.models.locations import LocationNode, LotAllocation
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool


@pytest_asyncio.fixture
async def sessionmaker_factory():
    """A sessionmaker on a throwaway engine, one per test.

    The app's global engine is a module singleton whose pool binds to the
    first event loop it sees; pytest-asyncio gives each test a fresh loop, so
    reusing it raises "attached to a different loop". A per-test engine also
    lets us use ``NullPool``, which matters here: these tests need two
    genuinely separate connections held open at the same time, and a pooled
    engine may hand back the same one.
    """
    engine = create_async_engine(str(get_settings().database_url), poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def stock_fixture(sessionmaker_factory):
    """Create an isolated lot + allocation holding 5 units, and clean up.

    Reuses whatever item / node / user already exist rather than building the
    whole catalogue graph — the test is about row locking, not about seeding.
    """
    sessionmaker = sessionmaker_factory
    async with sessionmaker() as s:
        item_id = (await s.execute(select(Item.id).limit(1))).scalar_one_or_none()
        node_id = (await s.execute(select(LocationNode.id).limit(1))).scalar_one_or_none()
        user_id = (
            await s.execute(select(Lot.created_by_user_id).limit(1))
        ).scalar_one_or_none()
        if item_id is None or node_id is None or user_id is None:
            pytest.skip("dev database has no item/node/user to hang a test lot on")

        lot = Lot(
            item_id=item_id,
            lot_number=f"VR004-{uuid.uuid4().hex[:10]}",
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
        )
        s.add(lot)
        await s.flush()

        alloc = LotAllocation(
            lot_id=lot.id,
            location_node_id=node_id,
            qty=Decimal("5"),
            created_by_user_id=user_id,
        )
        s.add(alloc)
        await s.commit()
        alloc_id, lot_id = alloc.id, lot.id

    yield sessionmaker, alloc_id

    async with sessionmaker() as s:
        await s.execute(delete(LotAllocation).where(LotAllocation.lot_id == lot_id))
        await s.execute(delete(Lot).where(Lot.id == lot_id))
        await s.commit()


async def _draw(sessionmaker, alloc_id: uuid.UUID, qty: int, barrier: asyncio.Barrier) -> str:
    """Take ``qty`` from the allocation in its own transaction.

    The barrier releases both callers at the same instant and sits BEFORE the
    locking read, deliberately. Putting it after would deadlock the test
    rather than exercise the code: ``FOR UPDATE`` lets only one caller hold
    the row, so the second would block inside Postgres and never arrive at
    the barrier, leaving the first waiting on it forever. (That hang is
    itself proof the lock serialises — but it is not a useful test.)

    Starting both together and letting the database do the ordering is the
    realistic shape anyway: it is what two operators clicking at once
    actually produces.
    """
    await barrier.wait()
    async with sessionmaker() as s:
        alloc = await loc_repo.get_allocation(s, alloc_id, for_update=True)
        assert alloc is not None
        try:
            await loc_repo.reduce_allocation(s, allocation=alloc, qty=Decimal(qty))
            await s.commit()
            return "ok"
        except ConflictError:
            await s.rollback()
            return "conflict"


async def test_concurrent_issue_cannot_oversell(stock_fixture) -> None:
    """Two simultaneous draws of 3 from a stock of 5: exactly one may win.

    The old code let both through and left qty=2 — six units issued from five,
    with no error and nothing in the audit trail to show for it. The
    ``qty >= :qty`` guard now makes the loser fail loudly.
    """
    sessionmaker, alloc_id = stock_fixture
    barrier = asyncio.Barrier(2)

    results = await asyncio.gather(
        _draw(sessionmaker, alloc_id, 3, barrier),
        _draw(sessionmaker, alloc_id, 3, barrier),
        return_exceptions=True,
    )
    outcomes = [r for r in results if isinstance(r, str)]

    assert outcomes.count("ok") == 1, f"expected exactly one winner, got {results}"

    async with sessionmaker() as s:
        final = (
            await s.execute(select(LotAllocation.qty).where(LotAllocation.id == alloc_id))
        ).scalar_one()
    # 5 - 3 = 2. If this is 2 but BOTH calls returned "ok", the lost update is
    # back: the assertion above is what catches that, not this one.
    assert final == Decimal("2"), f"expected 2 left, got {final}"


async def test_concurrent_draws_that_both_fit_are_both_applied(stock_fixture) -> None:
    """Serialisation must not lose a legitimate update either.

    Two draws of 2 from 5 both fit, so both must succeed and the total must be
    exactly 4 — proving the guard rejects only real over-draws rather than
    dropping one of two valid writes.
    """
    sessionmaker, alloc_id = stock_fixture
    barrier = asyncio.Barrier(2)

    results = await asyncio.gather(
        _draw(sessionmaker, alloc_id, 2, barrier),
        _draw(sessionmaker, alloc_id, 2, barrier),
        return_exceptions=True,
    )
    assert [r for r in results if isinstance(r, str)].count("ok") == 2, results

    async with sessionmaker() as s:
        final = (
            await s.execute(select(LotAllocation.qty).where(LotAllocation.id == alloc_id))
        ).scalar_one()
    assert final == Decimal("1"), f"expected 1 left (5-2-2), got {final}"


async def test_draw_exceeding_stock_is_refused(stock_fixture) -> None:
    """The single-caller case still behaves: 9 from 5 is a conflict, not a
    negative balance."""
    sessionmaker, alloc_id = stock_fixture
    async with sessionmaker() as s:
        alloc = await loc_repo.get_allocation(s, alloc_id, for_update=True)
        assert alloc is not None
        with pytest.raises(ConflictError) as excinfo:
            await loc_repo.reduce_allocation(s, allocation=alloc, qty=Decimal("9"))
        assert excinfo.value.code == "stock_conflict"
        await s.rollback()

    async with sessionmaker() as s:
        final = (
            await s.execute(select(LotAllocation.qty).where(LotAllocation.id == alloc_id))
        ).scalar_one()
    assert final == Decimal("5"), "a refused draw must leave stock untouched"
