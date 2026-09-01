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
from app.kitting import costing
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
        cost_is_complete=True,
        performed_by_user_id=user.id,
        reauth_evidence_id=None,
    )
    await kit_repo.create_batch_consumption(
        s,
        batch_id=batch.id,
        kit_line_id=line.id,
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
            cost_is_complete=True,
            performed_by_user_id=user.id,
            reauth_evidence_id=None,
        )
        await kit_repo.create_batch_consumption(
            s,
            batch_id=batch.id,
            kit_line_id=line.id,
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
        cost_is_complete=True,
        performed_by_user_id=user.id,
        reauth_evidence_id=None,
    )
    assert batch.output_lot_id is None


# ── The constraints that encode the design ──────────────────────────────


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


# ── Price corrections propagate (RPT-003, client 2026-08-31) ────────────


async def _produce(s, kit, line, user, *, batch_no, qty, good, lot):
    """Record a batch the way ``_produce_batch`` does, at today's prices."""
    from app.kitting import recompute as kit_recompute

    batch = await kit_repo.create_batch(
        s,
        kit_id=kit.id,
        batch_no=batch_no,
        output_lot_id=lot.id,
        good_qty=good,
        scrap_qty=0,
        material_cost_amount=None,
        unit_cost_amount=None,
        cost_is_complete=True,
        performed_by_user_id=user.id,
        reauth_evidence_id=None,
    )
    await kit_repo.create_batch_consumption(
        s,
        batch_id=batch.id,
        kit_line_id=line.id,
        qty=qty,
        unit_cost_amount=None,
        extended_value_amount=None,
        cost_is_complete=True,
    )
    # Cost it for the first time by replaying — the same path a correction uses,
    # so the test proves the replay against a known answer before relying on it.
    await kit_recompute.recompute_kit(s, kit_id=kit.id)
    return batch


async def test_correcting_an_input_price_restamps_the_produced_lot(kit_fixture):
    """The client's question, as a test.

    Issue 100 @ $1, make 10 units → the finished lot is stamped $10/unit.
    Correct the input to $2 and the finished lot must become $20/unit — the
    whole point of the 2026-08-31 change. Before it, this stayed at $10 while
    the kit header said $200, and the page disagreed with itself.
    """
    from app.kitting import recompute as kit_recompute

    s, kit, line, user, make_lot, issue, _credit = kit_fixture
    source = await make_lot(Decimal("1"))
    await issue(source, 100)
    out = await make_lot(None)
    await _produce(s, kit, line, user, batch_no=1, qty=100, good=10, lot=out)

    assert out.unit_price_amount == Decimal("10.000000")

    source.unit_price_amount = Decimal("2")
    await s.flush()
    result = await kit_recompute.recompute_kits_for_lot(s, lot_id=source.id)

    assert out.unit_price_amount == Decimal("20.000000")
    assert result.kits_visited == 1
    assert result.lots_repriced[out.lot_number] == (Decimal("10.000000"), Decimal("20.000000"))


async def test_the_batch_breakdown_moves_with_it(kit_fixture):
    """The per-component rows are recomputed too, not just the lot price.

    If they were left behind, the drill-down would still explain the OLD number
    while the lot showed the new one — the same self-contradiction on a smaller
    screen.
    """
    from app.kitting import recompute as kit_recompute

    s, kit, line, user, make_lot, issue, _credit = kit_fixture
    source = await make_lot(Decimal("1"))
    await issue(source, 100)
    out = await make_lot(None)
    batch = await _produce(s, kit, line, user, batch_no=1, qty=100, good=10, lot=out)
    assert batch.material_cost_amount == Decimal("100")

    source.unit_price_amount = Decimal("3")
    await s.flush()
    await kit_recompute.recompute_kits_for_lot(s, lot_id=source.id)

    assert batch.material_cost_amount == Decimal("300")
    assert batch.consumptions[0].extended_value_amount == Decimal("300")
    assert batch.consumptions[0].unit_cost_amount == Decimal("3")


async def test_a_correction_cascades_into_the_finished_good(kit_fixture):
    """An AY's price correction must reach the FG built from it.

    This is the case a one-level recompute would miss: the sub-assembly's own
    lot is re-stamped, and unless the cascade follows it, the finished good goes
    on carrying a cost derived from a price nothing else believes any more.
    """
    from app.kitting import recompute as kit_recompute
    from app.models.kitting import Kit, KitLine

    s, kit, line, user, make_lot, issue, _credit = kit_fixture
    # Kit 1: raw material → an AY lot.
    source = await make_lot(Decimal("1"))
    await issue(source, 100)
    ay = await make_lot(None)
    await _produce(s, kit, line, user, batch_no=1, qty=100, good=10, lot=ay)
    assert ay.unit_price_amount == Decimal("10.000000")

    # Kit 2 consumes that AY and produces a finished good.
    kit2 = Kit(
        kit_number=f"{kit.kit_number}-FG",
        item_id=kit.item_id,
        target_qty=5,
        status="in_production",
        production_location_node_id=kit.production_location_node_id,
        created_by_user_id=user.id,
    )
    s.add(kit2)
    await s.flush()
    line2 = KitLine(
        kit_id=kit2.id, line_no=1, item_id=line.item_id, qty_per_unit=Decimal("1.000"), issued_qty=0
    )
    s.add(line2)
    await s.flush()
    s.add(
        StockMovement(
            item_id=line.item_id,
            lot_id=ay.id,
            movement_type="kit_issue",
            qty_delta=-10,
            qty_abs=10,
            from_location_node_id=kit.production_location_node_id,
            to_location_node_id=kit.production_location_node_id,
            kit_id=kit2.id,
            kit_line_id=line2.id,
            performed_by_user_id=user.id,
        )
    )
    await s.flush()
    fg = await make_lot(None)
    await _produce(s, kit2, line2, user, batch_no=1, qty=10, good=5, lot=fg)
    # 10 AY units at $10 = $100 over 5 good = $20 each.
    assert fg.unit_price_amount == Decimal("20.000000")

    # Correct the ORIGINAL raw material. It must reach the FG two hops away.
    source.unit_price_amount = Decimal("2")
    await s.flush()
    result = await kit_recompute.recompute_kits_for_lot(s, lot_id=source.id)

    assert ay.unit_price_amount == Decimal("20.000000")
    assert fg.unit_price_amount == Decimal("40.000000")
    assert result.kits_visited == 2
    assert set(result.lots_repriced) == {ay.lot_number, fg.lot_number}


async def test_a_kit_that_never_touched_the_lot_is_left_alone(kit_fixture):
    """The recompute frontier is charges, not proximity.

    A kit sharing the production floor — or the same item from a different lot —
    must not be re-costed, or a price correction would ripple across unrelated
    customers' bills.
    """
    from app.kitting import recompute as kit_recompute

    s, kit, line, user, make_lot, issue, _credit = kit_fixture
    used = await make_lot(Decimal("1"))
    untouched = await make_lot(Decimal("5"))
    await issue(used, 100)
    out = await make_lot(None)
    await _produce(s, kit, line, user, batch_no=1, qty=100, good=10, lot=out)

    untouched.unit_price_amount = Decimal("50")
    await s.flush()
    result = await kit_recompute.recompute_kits_for_lot(s, lot_id=untouched.id)

    assert result.kits_visited == 0
    assert out.unit_price_amount == Decimal("10.000000")


# ── Kit creation actually persists its identity ─────────────────────────
#
# These exist because a blunt ``sed`` once deleted ``item_id=item_id`` from
# ``create_kit`` and ``add_kit_line``, and the whole suite stayed green while
# no kit could be created at all — the failure only surfaced when a person
# clicked the button. Every NOT NULL column a repository helper is responsible
# for is worth one cheap assertion.


async def test_create_kit_persists_every_required_column(kit_fixture):
    """A kit round-trips with its item, target and location intact.

    ``item_id`` is the one that broke: NOT NULL in the database, so losing it
    is a 500 on the first insert rather than a subtly wrong row.
    """
    s, kit, line, user, _make_lot, _issue, _credit = kit_fixture
    created = await kit_repo.create_kit(
        s,
        kit_number=f"{kit.kit_number}-NEW",
        item_id=kit.item_id,
        target_qty=7,
        production_location_node_id=kit.production_location_node_id,
        notes="round-trip",
        created_by_user_id=user.id,
    )
    await s.flush()

    assert created.item_id == kit.item_id, "item_id must reach the row"
    assert created.target_qty == 7
    assert created.production_location_node_id == kit.production_location_node_id
    assert created.created_by_user_id == user.id
    assert created.status == "draft"


async def test_add_kit_line_persists_its_component(kit_fixture):
    """The same guard for lines — a line without an item is not a line."""
    s, kit, line, user, _make_lot, _issue, _credit = kit_fixture
    # A DISTINCT component: ``uq_kit_lines_kit_item`` allows one line per item
    # per kit, and the fixture already spent this kit's on ``line``.
    existing = (await s.execute(select(Item).where(Item.id == line.item_id))).scalar_one()
    second = Item(
        prefix_id=existing.prefix_id,
        sku_suffix=f"X{uuid.uuid4().hex[:8]}",
        description="second component",
        created_by_user_id=user.id,
        updated_by_user_id=user.id,
    )
    s.add(second)
    await s.flush()

    added = await kit_repo.add_kit_line(
        s,
        kit_id=kit.id,
        line_no=2,
        item_id=second.id,
        qty_per_unit=Decimal("2.500"),
        consumed_in_kit=False,
        issued_qty=0,
        source_location_node_id=None,
    )
    await s.flush()

    assert added.item_id == second.id, "item_id must reach the row"
    assert added.kit_id == kit.id
    assert added.line_no == 2
    assert added.qty_per_unit == Decimal("2.500")
    assert added.consumed_in_kit is False


async def test_no_repository_helper_silently_drops_a_parameter():
    """Catch the *class* of bug, not just the two instances of it.

    A keyword-only parameter that a helper accepts and then never mentions in
    its body is almost always a line that went missing — which is exactly how
    ``create_kit`` lost ``item_id`` without a single test noticing.
    """
    import ast
    import pathlib

    src = pathlib.Path(kit_repo.__file__).read_text(encoding="utf-8")
    orphaned: list[str] = []
    for node in ast.walk(ast.parse(src)):
        if not isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef):
            continue
        params = [a.arg for a in node.args.args + node.args.kwonlyargs]
        used = {
            n.id
            for stmt in node.body
            for n in ast.walk(stmt)
            if isinstance(n, ast.Name)
        }
        orphaned += [
            f"{node.name}({p})"
            for p in params
            if not p.startswith("_") and p not in used
        ]
    assert not orphaned, f"accepted but never used: {orphaned}"


# ── KIT-003: the media line's cost is never credited away ───────────────
#
# The requirement's second half — "the cost ($$/unit) should pull through with
# the kit costs" — is satisfied by the material simply being CONSUMED instead of
# returned. These pin that, on the same aggregate the batch attribution divides.


async def test_media_is_charged_and_never_credited(kit_fixture):
    """Ten feedings of media at $3, one kit: $30 charged, nothing credited.

    A back-flush would post a ``backflush`` row and land in ``credited``,
    cancelling the charge out. Because the close-out consumes whatever is left
    instead, ``charged - credited`` stays at the full $30 and that is what the
    batch attribution has to spend on the finished lot.
    """
    s, kit, line, _user, make_lot, issue, _credit = kit_fixture
    media = await make_lot(Decimal("3"))
    # One "Issue more" per feeding, as the client describes the procedure.
    for _ in range(10):
        await issue(media, 1)

    charged, credited, unpriced = (await kit_repo.line_charge_credit_values(s, kit.id))[
        line.id
    ]
    assert charged == Decimal("30.000000")
    assert credited == Decimal("0"), "media is never handed back, so never credited"
    assert unpriced == 0


async def test_a_fully_consumed_media_line_values_at_its_lot_price(kit_fixture):
    """$3 a unit in, $3 a unit onto the batch — no dilution, no residual.

    At close-out a media line consumes its whole remaining floor, so the moving
    average is ``(charged - 0 - 0) / floor`` and the extended value it hands the
    final batch is the entire charge. The finished lot carries all of it.
    """
    s, kit, line, _user, make_lot, issue, _credit = kit_fixture
    await issue(await make_lot(Decimal("3")), 10)

    charged, credited, _unpriced = (await kit_repo.line_charge_credit_values(s, kit.id))[
        line.id
    ]
    unit = costing.line_unit_cost(
        charged=charged, credited=credited, consumed=Decimal("0"), residual_qty=10
    )
    assert unit == Decimal("3")
    assert costing.line_extended_value(unit, 10) == Decimal("30")


async def test_each_batch_is_charged_only_what_it_recorded(kit_fixture):
    """The multi-day case: each batch carries only what it recorded.

    Batch 1 is an ordinary produce and takes the 4 the operator entered; the
    close-out then pours the remaining 6. Consuming the whole floor at batch 1 —
    the shape this was first built as — would have put all $20 on the first lot
    and billed the second against no material at all.
    """
    s, kit, line, _user, make_lot, issue, _credit = kit_fixture
    media = await make_lot(Decimal("2"))
    await issue(media, 4)

    charged, credited, _u = (await kit_repo.line_charge_credit_values(s, kit.id))[line.id]
    first = costing.line_extended_value(
        costing.line_unit_cost(
            charged=charged, credited=credited, consumed=Decimal("0"), residual_qty=4
        ),
        4,
    )
    assert first == Decimal("8")

    # The close-out pours what is left.
    await issue(media, 6)
    charged, credited, _u = (await kit_repo.line_charge_credit_values(s, kit.id))[line.id]
    second = costing.line_extended_value(
        costing.line_unit_cost(
            charged=charged, credited=credited, consumed=first, residual_qty=6
        ),
        6,
    )
    assert second == Decimal("12")
    assert first + second == charged, "every dollar issued reaches a finished lot"
