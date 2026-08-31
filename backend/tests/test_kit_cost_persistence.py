"""The cost queries and the costing tables, against a real database (RPT-003).

``test_kit_cost_flow.py`` proves the arithmetic. This proves the two things
arithmetic cannot: that the aggregate queries read the ledger the way the
formula assumes, and that the ``kitcost01`` tables actually accept — and
refuse — the rows the design depends on.

Everything is seeded inside a transaction that is rolled back, so the tests
leave nothing behind and do not care what is already in the database. The dev
DB was reset on 2026-08-25 and holds no items, so a test that reused existing
rows would silently skip and guard nothing.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
import pytest_asyncio
from app.core.config import get_settings
from app.kitting import repository as kit_repo
from app.models.identity import User
from app.models.inventory import Item, ItemPrefix, ItemTier, Lot, StockMovement
from app.models.kitting import Kit, KitLine, KitProductionBatch
from app.models.locations import LocationNode
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

pytestmark = pytest.mark.anyio


@pytest_asyncio.fixture
async def session_factory():
    """A sessionmaker on a throwaway engine, one per test.

    The app's global engine binds its pool to the first event loop it sees and
    pytest-asyncio hands each test a fresh one — same reasoning as the PLN-002
    guards.
    """
    engine = create_async_engine(str(get_settings().database_url), poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def kit_fixture(session_factory):
    """Yield ``(session, kit, line, make_lot, issue, credit)``, rolled back.

    ``make_lot(price)`` mints a lot at a price (``None`` for unpriced, and
    ``Decimal("0")`` for the customer-owned-cells case — the two are different
    facts and the tests below depend on the difference).

    ``issue(lot, qty)`` and ``credit(lot, qty)`` write the ledger rows the cost
    query reads. Both ends of the location are set because
    ``ck_movements_locations`` requires them on the kit movement types.
    """
    async with session_factory() as s:
        tag = uuid.uuid4().hex[:8]
        user = User(
            cognito_sub=f"rpt003-{tag}",
            email=f"rpt003-{tag}@example.invalid",
            full_name="RPT-003 fixture",
            initials="RF",
            role="super_admin",
        )
        s.add(user)
        await s.flush()

        tier = ItemTier(
            name=f"RPT-003 tier {tag}",
            type="raw_material",
            tone="neutral",
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
        )
        s.add(tier)
        await s.flush()
        prefix = ItemPrefix(
            tier_id=tier.id,
            code=f"R{tag[:4].upper()}",
            label="RPT-003 fixture",
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
        )
        s.add(prefix)
        await s.flush()

        def _node(name: str) -> LocationNode:
            return LocationNode(
                node_type="room",
                code=f"R3{name}{tag[:5].upper()}",
                name=f"RPT-003 {name}",
                created_by_user_id=user.id,
            )

        source, floor = _node("SRC"), _node("PRD")
        s.add_all([source, floor])
        await s.flush()

        def _item(suffix: str) -> Item:
            return Item(
                prefix_id=prefix.id,
                sku_suffix=f"{suffix}{tag[:5]}",
                description=f"RPT-003 {suffix}",
                created_by_user_id=user.id,
                updated_by_user_id=user.id,
            )

        parent, component = _item("FG"), _item("CR")
        s.add_all([parent, component])
        await s.flush()

        kit = Kit(
            kit_number=f"KIT-R3-{tag}",
            item_id=parent.id,
            target_qty=10,
            status="in_production",
            production_location_node_id=floor.id,
            created_by_user_id=user.id,
        )
        s.add(kit)
        await s.flush()
        line = KitLine(
            kit_id=kit.id,
            line_no=1,
            item_id=component.id,
            qty_per_unit=Decimal("1.000"),
            issued_qty=0,
        )
        s.add(line)
        await s.flush()

        lot_seq = 0

        async def make_lot(price: Decimal | None) -> Lot:
            nonlocal lot_seq
            lot_seq += 1
            lot = Lot(
                item_id=component.id,
                lot_number=f"R3-{tag}-{lot_seq}",
                unit_price_amount=price,
                created_by_user_id=user.id,
                updated_by_user_id=user.id,
            )
            s.add(lot)
            await s.flush()
            return lot

        async def _movement(lot: Lot, qty: int, mv_type: str, delta_sign: int) -> None:
            s.add(
                StockMovement(
                    item_id=component.id,
                    lot_id=lot.id,
                    movement_type=mv_type,
                    qty_delta=delta_sign * qty,
                    qty_abs=qty,
                    from_location_node_id=source.id if delta_sign < 0 else floor.id,
                    to_location_node_id=floor.id if delta_sign < 0 else source.id,
                    kit_id=kit.id,
                    kit_line_id=line.id,
                    performed_by_user_id=user.id,
                )
            )
            await s.flush()

        async def issue(lot: Lot, qty: int) -> None:
            await _movement(lot, qty, "kit_issue", -1)
            line.issued_qty += qty

        async def credit(lot: Lot, qty: int) -> None:
            await _movement(lot, qty, "kit_return", 1)
            line.early_returned_qty += qty

        yield s, kit, line, user, make_lot, issue, credit
        await s.rollback()


# ── The charge/credit aggregate ─────────────────────────────────────────


async def test_a_single_priced_issue_charges_the_line(kit_fixture):
    s, kit, line, _user, make_lot, issue, _credit = kit_fixture
    await issue(await make_lot(Decimal("1.50")), 100)

    values = await kit_repo.line_charge_credit_values(s, kit.id)
    charged, credited, unpriced = values[line.id]
    assert charged == Decimal("150.000000")
    assert credited == Decimal("0")
    assert unpriced == 0


async def test_two_lots_sum_into_one_line(kit_fixture):
    """The blend the moving average later divides — 100 @ $1 + 100 @ $3."""
    s, kit, line, _user, make_lot, issue, _credit = kit_fixture
    await issue(await make_lot(Decimal("1")), 100)
    await issue(await make_lot(Decimal("3")), 100)

    charged, _credited, unpriced = (await kit_repo.line_charge_credit_values(s, kit.id))[line.id]
    assert charged == Decimal("400.000000")
    assert unpriced == 0


async def test_a_return_is_credited_not_charged(kit_fixture):
    """The discriminating case: returns must reduce the kit's cost.

    Issue 50 @ $1 and 50 @ $3, hand the $3 lot back. Net is $50, so the
    remaining 50 units are worth $1 each. A query that ignored the credit side
    would report $200 and double the customer's bill.
    """
    s, kit, line, _user, make_lot, issue, credit = kit_fixture
    cheap, dear = await make_lot(Decimal("1")), await make_lot(Decimal("3"))
    await issue(cheap, 50)
    await issue(dear, 50)
    await credit(dear, 50)

    charged, credited, _unpriced = (await kit_repo.line_charge_credit_values(s, kit.id))[line.id]
    assert charged == Decimal("200.000000")
    assert credited == Decimal("150.000000")
    assert charged - credited == Decimal("50.000000")


async def test_an_unpriced_issue_makes_the_line_unknown(kit_fixture):
    """Not a partial sum of the priced half — the whole line is unknown."""
    s, kit, line, _user, make_lot, issue, _credit = kit_fixture
    await issue(await make_lot(Decimal("2")), 50)
    await issue(await make_lot(None), 50)

    charged, _credited, unpriced = (await kit_repo.line_charge_credit_values(s, kit.id))[line.id]
    assert charged is None
    assert unpriced == 50


async def test_a_zero_priced_lot_is_known_and_free(kit_fixture):
    """The J&J case: customer-owned cells on a $0 PO cost a real nothing.

    ``charged`` must be ``Decimal("0")`` and NOT ``None`` — blank would say we
    do not know what they cost, and we do.
    """
    s, kit, line, _user, make_lot, issue, _credit = kit_fixture
    await issue(await make_lot(Decimal("0")), 25)

    charged, _credited, unpriced = (await kit_repo.line_charge_credit_values(s, kit.id))[line.id]
    assert charged == Decimal("0")
    assert unpriced == 0


async def test_movements_of_another_kit_are_not_counted(kit_fixture):
    """Cost is scoped by kit_id, which is why the shared floor cannot leak in.

    The production floor holds several kits' material at once
    (``allocations_for_item_at_node`` has no kit filter), so this scoping is
    the entire reason cost is derived from the ledger rather than the floor.
    """
    s, kit, line, user, make_lot, issue, _credit = kit_fixture
    await issue(await make_lot(Decimal("1")), 100)

    other = Kit(
        kit_number=f"{kit.kit_number}-OTHER",
        item_id=kit.item_id,
        target_qty=5,
        status="in_production",
        production_location_node_id=kit.production_location_node_id,
        created_by_user_id=user.id,
    )
    s.add(other)
    await s.flush()
    expensive = await make_lot(Decimal("99"))
    s.add(
        StockMovement(
            item_id=line.item_id,
            lot_id=expensive.id,
            movement_type="kit_issue",
            qty_delta=-100,
            qty_abs=100,
            from_location_node_id=kit.production_location_node_id,
            to_location_node_id=kit.production_location_node_id,
            kit_id=other.id,
            performed_by_user_id=user.id,
        )
    )
    await s.flush()

    charged, _c, _u = (await kit_repo.line_charge_credit_values(s, kit.id))[line.id]
    assert charged == Decimal("100.000000")  # not 9,900


# ── The batch tables ────────────────────────────────────────────────────


async def test_batch_and_consumption_round_trip(kit_fixture):
    s, kit, line, user, make_lot, issue, _credit = kit_fixture
    await issue(await make_lot(Decimal("1")), 100)

    assert await kit_repo.next_batch_no(s, kit.id) == 1
    lot = await make_lot(Decimal("1"))
    batch = await kit_repo.create_batch(
        s,
        kit_id=kit.id,
        batch_no=1,
        output_lot_id=lot.id,
        good_qty=4,
        scrap_qty=1,
        material_cost_amount=Decimal("450"),
        unit_cost_amount=Decimal("112.500000"),
        scrap_value_amount=Decimal("112.500000"),
        cost_is_complete=True,
        performed_by_user_id=user.id,
        reauth_evidence_id=None,
    )
    await kit_repo.create_batch_consumption(
        s,
        batch_id=batch.id,
        kit_line_id=line.id,
        item_id=line.item_id,
        qty=50,
        unit_cost_amount=Decimal("9"),
        extended_value_amount=Decimal("450"),
        cost_is_complete=True,
    )

    assert await kit_repo.next_batch_no(s, kit.id) == 2
    assert await kit_repo.consumed_values_by_line(s, kit.id) == {line.id: Decimal("450.000000")}
    batches = await kit_repo.batches_for_kit(s, kit.id)
    assert [b.batch_no for b in batches] == [1]
    assert batches[0].unit_cost_amount == Decimal("112.500000")


async def test_consumed_value_accumulates_across_batches(kit_fixture):
    """The third term of the moving average — batch 2 must not respend batch 1."""
    s, kit, line, user, make_lot, issue, _credit = kit_fixture
    await issue(await make_lot(Decimal("2")), 200)

    for n in (1, 2):
        lot = await make_lot(Decimal("2"))
        batch = await kit_repo.create_batch(
            s,
            kit_id=kit.id,
            batch_no=n,
            output_lot_id=lot.id,
            good_qty=5,
            scrap_qty=0,
            material_cost_amount=Decimal("100"),
            unit_cost_amount=Decimal("20"),
            scrap_value_amount=Decimal("0"),
            cost_is_complete=True,
            performed_by_user_id=user.id,
            reauth_evidence_id=None,
        )
        await kit_repo.create_batch_consumption(
            s,
            batch_id=batch.id,
            kit_line_id=line.id,
            item_id=line.item_id,
            qty=50,
            unit_cost_amount=Decimal("2"),
            extended_value_amount=Decimal("100"),
            cost_is_complete=True,
        )

    assert await kit_repo.consumed_values_by_line(s, kit.id) == {line.id: Decimal("200.000000")}


async def test_a_scrap_only_batch_mints_no_lot(kit_fixture):
    """``good_qty=0`` is reachable through close-out and must be storable."""
    s, kit, _line, user, _make_lot, _issue, _credit = kit_fixture
    batch = await kit_repo.create_batch(
        s,
        kit_id=kit.id,
        batch_no=1,
        output_lot_id=None,
        good_qty=0,
        scrap_qty=3,
        material_cost_amount=Decimal("60"),
        unit_cost_amount=None,
        scrap_value_amount=None,
        cost_is_complete=True,
        performed_by_user_id=user.id,
        reauth_evidence_id=None,
    )
    assert batch.output_lot_id is None


# ── The constraints that encode the design ──────────────────────────────


async def test_scrap_value_may_not_exceed_the_batch_cost(kit_fixture):
    """The DB refuses to let scrap become an addend.

    This is the constraint that stops someone re-deriving "material + scrap" as
    the kit total. Scrap is a SLICE of the material cost — the scrapped units'
    material was charged at issue and is already inside it.
    """
    s, kit, _line, user, make_lot, _issue, _credit = kit_fixture
    lot = await make_lot(Decimal("1"))
    with pytest.raises(IntegrityError):
        await kit_repo.create_batch(
            s,
            kit_id=kit.id,
            batch_no=1,
            output_lot_id=lot.id,
            good_qty=4,
            scrap_qty=1,
            material_cost_amount=Decimal("450"),
            unit_cost_amount=Decimal("112.5"),
            scrap_value_amount=Decimal("500"),  # more than the whole batch
            cost_is_complete=True,
            performed_by_user_id=user.id,
            reauth_evidence_id=None,
        )


async def test_an_incomplete_cost_may_not_carry_numbers(kit_fixture):
    """Unknown means blank everywhere, never a partial figure."""
    s, kit, _line, user, make_lot, _issue, _credit = kit_fixture
    lot = await make_lot(Decimal("1"))
    with pytest.raises(IntegrityError):
        await kit_repo.create_batch(
            s,
            kit_id=kit.id,
            batch_no=1,
            output_lot_id=lot.id,
            good_qty=4,
            scrap_qty=0,
            material_cost_amount=Decimal("450"),
            unit_cost_amount=Decimal("112.5"),
            scrap_value_amount=None,
            cost_is_complete=False,  # contradicts the numbers above
            performed_by_user_id=user.id,
            reauth_evidence_id=None,
        )


async def test_a_batch_that_made_nothing_may_not_claim_a_lot(kit_fixture):
    s, kit, _line, user, make_lot, _issue, _credit = kit_fixture
    lot = await make_lot(Decimal("1"))
    with pytest.raises(IntegrityError):
        await kit_repo.create_batch(
            s,
            kit_id=kit.id,
            batch_no=1,
            output_lot_id=lot.id,
            good_qty=0,  # nothing was made, so there is no lot to point at
            scrap_qty=2,
            material_cost_amount=None,
            unit_cost_amount=None,
            scrap_value_amount=None,
            cost_is_complete=True,
            performed_by_user_id=user.id,
            reauth_evidence_id=None,
        )


async def test_one_output_lot_belongs_to_one_batch(kit_fixture):
    """A second batch may not claim a lot another batch already minted."""
    s, kit, _line, user, make_lot, _issue, _credit = kit_fixture
    lot = await make_lot(Decimal("1"))
    common = {
        "kit_id": kit.id,
        "output_lot_id": lot.id,
        "good_qty": 1,
        "scrap_qty": 0,
        "material_cost_amount": Decimal("10"),
        "unit_cost_amount": Decimal("10"),
        "scrap_value_amount": Decimal("0"),
        "cost_is_complete": True,
        "performed_by_user_id": user.id,
        "reauth_evidence_id": None,
    }
    await kit_repo.create_batch(s, batch_no=1, **common)
    with pytest.raises(IntegrityError):
        await kit_repo.create_batch(s, batch_no=2, **common)


async def test_batches_cascade_when_a_kit_is_deleted(kit_fixture):
    """A kit's costing rows are its own; the output lot is not (RESTRICT)."""
    s, kit, _line, user, make_lot, _issue, _credit = kit_fixture
    lot = await make_lot(Decimal("1"))
    await kit_repo.create_batch(
        s,
        kit_id=kit.id,
        batch_no=1,
        output_lot_id=lot.id,
        good_qty=1,
        scrap_qty=0,
        material_cost_amount=Decimal("10"),
        unit_cost_amount=Decimal("10"),
        scrap_value_amount=Decimal("0"),
        cost_is_complete=True,
        performed_by_user_id=user.id,
        reauth_evidence_id=None,
    )
    await s.delete(kit)
    await s.flush()
    remaining = (
        await s.execute(select(KitProductionBatch).where(KitProductionBatch.kit_id == kit.id))
    ).scalars().all()
    assert remaining == []
