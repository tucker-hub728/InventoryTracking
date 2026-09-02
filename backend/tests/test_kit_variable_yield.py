"""A grown item's yield is measured, not derived (client 2026-09-01, varyield01).

    "When growing virus or creating a protein, the constraint isn't the yield
    for the consumption of the raw material or assemblies. For example: one
    TREX reactor with 4 media feedings could result in a yield of 200 grams of
    material. The next time it is produced it could consume the exact same raw
    materials but yield 350 grams of material. The software (correctly for what
    we knew yesterday) constrained the parts 1:many (depending on scrap)."
    — Blane Larson, 2026-09-01

The gate that constrained it is ``used_below_need`` in ``_produce_batch``: the
material recorded as used must cover ``ceil(qty_per_unit × (good + scrap))``.

The run that breaks is the OVER-yield one, which is worth pinning explicitly
because the error message points the other way. With 200 units of material
issued against a 1:1 recipe, a 200-unit yield passes and a 350-unit yield is
refused — ``need`` becomes 350 while only 200 was used. The operator cannot work
around it either: ``used_exceeds_issued`` caps ``used`` at what is on the floor.
So the *better* run is the one the software will not record. That pair is
``test_the_clients_350g_run_is_refused_without_the_flag`` /
``test_the_clients_350g_run_is_recorded_with_the_flag`` below.

One flag, snapshotted from the built item onto the kit, and it changes exactly
that one check — **narrowing it, not deleting it**. The first cut deleted it, and
the user caught the consequence on the close-out screen: every component at Used
0 and the batch still accepted, i.e. output from no material, which makes the BOM
decorative. What is wrong for a grown item is that the OUTPUT sets the input
requirement; the recipe still says what one run takes (CR 1, AY 2) and that stays
the minimum however much comes out. Section 4b pins it.

``used_qty_missing`` and ``used_exceeds_issued`` are physical facts rather than
recipe arithmetic and are untouched — asserted in 4c, because a flag that quietly
switched off the whole pre-flight is the obvious way to get this wrong.

Same shape as ``test_kit_media_consumption``: unit-level assertions plus a
section that drives the real ``_produce_batch`` against real rows in a
rolled-back transaction. ``smoke_kitting.py`` would be the usual end-to-end home
but its fixtures are hard-coded dev ids and the dev database was reset on
2026-08-25, so it cannot run at all.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
import pytest_asyncio
from app.core.config import get_settings
from app.core.exceptions import ValidationError
from app.kitting import costing
from app.kitting import repository as kit_repo
from app.kitting import routes as kitting_routes
from app.kitting.routes import _on_floor
from app.models.identity import User
from app.models.inventory import Item, ItemPrefix, ItemTier, Lot, StockMovement
from app.models.kitting import Kit, KitLine
from app.models.locations import LocationNode, LotAllocation
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

pytestmark = pytest.mark.anyio


# ── 1. The arithmetic the gate is made of ───────────────────────────────
#
# ``default_issued_qty`` is what turns a recipe rate into the batch need. These
# state, in isolation, why a grown item cannot live under it.


def test_the_recipe_need_scales_strictly_with_the_attempted_quantity():
    """The linear assumption, stated plainly: double the output, double the need."""
    per = Decimal("1.000")
    assert kit_repo.default_issued_qty(per, 200) == 200
    assert kit_repo.default_issued_qty(per, 350) == 350


def test_a_bigger_yield_from_the_same_material_is_what_trips_the_gate():
    """200 units of material, a 350 unit yield: the need outruns what was used.

    The client's example reduced to two numbers. It is the *inequality* that is
    wrong for a bioreactor, not any quantity in it.
    """
    need = kit_repo.default_issued_qty(Decimal("1.000"), 350)
    assert need > 200, "the 350 g run fails the recipe floor"


def test_scrap_counts_toward_the_need_too():
    """``attempted`` is good + scrap, so scrap raises the bar as well."""
    assert kit_repo.default_issued_qty(Decimal("1.000"), 4 + 1) == 5


# ── 2. Costing was already yield-agnostic ───────────────────────────────
#
# Worth pinning rather than assuming: the reason this change is small is that
# ``output_unit_cost`` has always divided by the operator-entered good count.


def test_the_same_material_prices_differently_at_different_yields():
    """$700 of material over 200 units vs 350 — the money follows the real yield."""
    material = Decimal("700")
    assert costing.output_unit_cost(material, 200) == Decimal("3.500000")
    assert costing.output_unit_cost(material, 350) == Decimal("2.000000")


def test_a_better_yield_never_raises_the_unit_cost():
    material = Decimal("700")
    low = costing.output_unit_cost(material, 200)
    high = costing.output_unit_cost(material, 350)
    assert low is not None and high is not None
    assert high < low


# ── 3. The schema ───────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def session_factory():
    """A sessionmaker on a throwaway engine, one per test.

    Same reasoning as ``test_kit_media_consumption``: the app's global engine
    binds its pool to the first event loop it sees, and pytest-asyncio hands
    each test a fresh one.
    """
    engine = create_async_engine(str(get_settings().database_url), poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def seed(session_factory):
    """Yield ``(session, user, node, item_factory)``, rolled back afterwards."""
    async with session_factory() as s:
        tag = uuid.uuid4().hex[:8]
        user = User(
            cognito_sub=f"varyield-{tag}",
            email=f"varyield-{tag}@example.invalid",
            full_name="varyield fixture",
            initials="VY",
            role="super_admin",
        )
        s.add(user)
        await s.flush()
        tier = ItemTier(
            name=f"varyield tier {tag}",
            type="raw_material",
            tone="neutral",
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
        )
        s.add(tier)
        await s.flush()
        prefix = ItemPrefix(
            tier_id=tier.id,
            code=f"V{tag[:4].upper()}",
            label="varyield fixture",
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
        )
        s.add(prefix)
        await s.flush()
        node = LocationNode(
            node_type="room",
            code=f"VY{tag[:6].upper()}",
            name="varyield floor",
            created_by_user_id=user.id,
        )
        s.add(node)
        await s.flush()

        def item(suffix: str, **kw) -> Item:
            return Item(
                prefix_id=prefix.id,
                sku_suffix=f"{suffix}{tag[:5]}",
                description=f"varyield {suffix}",
                created_by_user_id=user.id,
                updated_by_user_id=user.id,
                **kw,
            )

        yield s, user, node, item
        await s.rollback()


async def test_an_item_cannot_be_both_a_consumable_and_variable_yield(seed):
    """A consumable is barred from bills of material, so it is never built.

    ``ck_items_consumable_xor_variable_yield`` — the DB backstop under the
    route's message.
    """
    s, _user, _node, item = seed
    s.add(item("BAD", is_consumable=True, variable_yield=True))
    with pytest.raises(IntegrityError) as exc:
        await s.flush()
    assert "ck_items_consumable_xor_variable_yield" in str(exc.value)
    await s.rollback()


async def test_the_flag_defaults_to_off_on_a_new_item(seed):
    """No backfill, no surprises: every item that already exists is unaffected."""
    s, _user, _node, item = seed
    plain = item("PLAIN")
    s.add(plain)
    await s.flush()
    assert plain.variable_yield is False


async def test_creating_a_kit_snapshots_the_flag_off_the_built_item(seed):
    """``create_kit`` carries the PARENT's flag onto the kit.

    KIT-003 does this per line from each component; variable yield is a fact
    about the process, so it comes off the item being built.
    """
    s, user, node, item = seed
    grown = item("VIRUS", variable_yield=True)
    s.add(grown)
    await s.flush()

    kit = await kit_repo.create_kit(
        s,
        kit_number=f"KIT-VY-{uuid.uuid4().hex[:8]}",
        item_id=grown.id,
        target_qty=1,
        production_location_node_id=node.id,
        notes=None,
        variable_yield=grown.variable_yield,
        created_by_user_id=user.id,
    )
    assert kit.variable_yield is True


async def test_an_ordinary_item_still_creates_an_ordinary_kit(seed):
    """The default path is untouched — a normal build is still constrained."""
    s, user, node, item = seed
    plain = item("WIDGET")
    s.add(plain)
    await s.flush()

    kit = await kit_repo.create_kit(
        s,
        kit_number=f"KIT-VY-{uuid.uuid4().hex[:8]}",
        item_id=plain.id,
        target_qty=1,
        production_location_node_id=node.id,
        notes=None,
        variable_yield=plain.variable_yield,
        created_by_user_id=user.id,
    )
    assert kit.variable_yield is False


async def test_the_kit_snapshot_does_not_follow_a_later_item_edit(seed):
    """The whole reason it is a snapshot.

    Flipping the item after the kit exists must not retroactively change what
    that kit was allowed to produce — a signed, closed record would otherwise
    change meaning without a single quantity moving.
    """
    s, user, node, item = seed
    grown = item("VIRUS", variable_yield=True)
    s.add(grown)
    await s.flush()
    kit = await kit_repo.create_kit(
        s,
        kit_number=f"KIT-VY-{uuid.uuid4().hex[:8]}",
        item_id=grown.id,
        target_qty=1,
        production_location_node_id=node.id,
        notes=None,
        variable_yield=grown.variable_yield,
        created_by_user_id=user.id,
    )
    assert kit.variable_yield is True

    grown.variable_yield = False
    await s.flush()
    await s.refresh(kit)
    assert kit.variable_yield is True, "the kit keeps the rules it started under"


# ── 4. Driving the real thing ───────────────────────────────────────────
#
# These seed a kit on a production floor and call the real ``_produce_batch`` —
# the real pre-flight, the real drain, the real cost attribution — so the
# requirement is proven against the code that ships rather than a description
# of it.


@pytest_asyncio.fixture
async def floor(session_factory):
    """A production node holding WIP, plus an output shelf. ``make_kit`` takes
    the flag so each test picks its own. Rolled back."""
    async with session_factory() as s:
        tag = uuid.uuid4().hex[:8]
        user = User(
            cognito_sub=f"varyielde2e-{tag}",
            email=f"varyielde2e-{tag}@example.invalid",
            full_name="varyield e2e",
            initials="VE",
            role="super_admin",
        )
        s.add(user)
        await s.flush()
        tier = ItemTier(
            name=f"varyield e2e tier {tag}",
            type="raw_material",
            tone="neutral",
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
        )
        s.add(tier)
        await s.flush()
        prefix = ItemPrefix(
            tier_id=tier.id,
            code=f"W{tag[:4].upper()}",
            label="varyield e2e",
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
        )
        s.add(prefix)
        await s.flush()

        def node(name: str) -> LocationNode:
            return LocationNode(
                node_type="room",
                code=f"VY{name}{tag[:5].upper()}",
                name=f"varyield {name}",
                created_by_user_id=user.id,
            )

        prod, shelf = node("PRD"), node("SHF")
        s.add_all([prod, shelf])
        await s.flush()

        def item(suffix: str, **kw) -> Item:
            return Item(
                prefix_id=prefix.id,
                sku_suffix=f"{suffix}{tag[:5]}",
                description=f"varyield {suffix}",
                created_by_user_id=user.id,
                updated_by_user_id=user.id,
                **kw,
            )

        cells = item("CELLS")
        reagent = item("REAGENT")
        s.add_all([cells, reagent])
        await s.flush()

        async def make_kit(*, variable_yield: bool, target_qty: int = 200) -> Kit:
            parent = item(f"V{uuid.uuid4().hex[:6]}", variable_yield=variable_yield)
            s.add(parent)
            await s.flush()
            k = Kit(
                kit_number=f"KIT-VE-{uuid.uuid4().hex[:8]}",
                item_id=parent.id,
                target_qty=target_qty,
                status="in_production",
                production_location_node_id=prod.id,
                variable_yield=variable_yield,
                created_by_user_id=user.id,
            )
            s.add(k)
            await s.flush()
            return k

        async def stock(component: Item, qty: int, price: Decimal | None) -> Lot:
            """A lot of ``component`` on the production floor — the state a kit
            is in after issuing."""
            lot = Lot(
                item_id=component.id,
                lot_number=f"VE-{uuid.uuid4().hex[:8]}",
                unit_price_amount=price,
                created_by_user_id=user.id,
                updated_by_user_id=user.id,
            )
            s.add(lot)
            await s.flush()
            s.add(
                LotAllocation(
                    lot_id=lot.id,
                    location_node_id=prod.id,
                    qty=qty,
                    created_by_user_id=user.id,
                )
            )
            await s.flush()
            return lot

        async def issue(kit: Kit, line: KitLine, lot: Lot, qty: int) -> None:
            s.add(
                StockMovement(
                    item_id=lot.item_id,
                    lot_id=lot.id,
                    movement_type="kit_issue",
                    qty_delta=-qty,
                    qty_abs=qty,
                    from_location_node_id=shelf.id,
                    to_location_node_id=prod.id,
                    kit_id=kit.id,
                    kit_line_id=line.id,
                    performed_by_user_id=user.id,
                )
            )
            line.issued_qty += qty
            await s.flush()

        yield s, user, shelf, cells, reagent, make_kit, stock, issue
        await s.rollback()


async def _line_for(s, kit, item, *, line_no=1, qty_per_unit="1.000"):
    return await kit_repo.add_kit_line(
        s,
        kit_id=kit.id,
        line_no=line_no,
        item_id=item.id,
        qty_per_unit=Decimal(qty_per_unit),
        consumed_in_kit=item.consumed_in_kit,
        issued_qty=0,
        source_location_node_id=None,
    )


async def _produce(s, kit, user, shelf, *, good, used_by_line, scrap=0):
    """Call the real ``_produce_batch``, placing the batch on ``shelf``.

    ``kit.lines`` is lazy — routes always arrive with it eager-loaded via
    ``_require_kit``, so it must be materialised before the pre-flight walks it
    or the first access raises ``MissingGreenlet``.
    """
    await s.refresh(kit, attribute_names=["lines"])
    await kitting_routes._produce_batch(
        s,
        kit=kit,
        good=good,
        scrap=scrap,
        destinations=[(shelf.id, good, [])] if good else [],
        expiration_date=None,
        lot_number=f"{kit.kit_number}-{(kit.good_qty or 0) + 1}" if good else None,
        used_by_line=used_by_line,
        evidence=None,
        note="varyield e2e",
        current=user,
    )


# ── 4a. The client's scenario, both ways round ──────────────────────────


async def test_the_clients_350g_run_is_refused_without_the_flag(floor):
    """The defect, reproduced. 200 units of material, a 350 unit yield.

    Note the error is an *input shortfall* — the software has no concept of
    over-production, so a good run reports as a material problem.
    """
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=False)
    line = await _line_for(s, kit, cells)
    await issue(kit, line, await stock(cells, 200, Decimal("1")), 200)

    with pytest.raises(ValidationError) as exc:
        await _produce(s, kit, user, shelf, good=350, used_by_line={line.id: 200})
    assert exc.value.code == "used_below_need"


async def test_the_operator_cannot_escape_it_by_claiming_more_material(floor):
    """Why the gate above is a dead end rather than an inconvenience.

    Satisfying ``used_below_need`` would mean recording 350 used — but only 200
    is on the floor, so the other gate refuses. There is no pair of numbers that
    records this run.
    """
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=False)
    line = await _line_for(s, kit, cells)
    await issue(kit, line, await stock(cells, 200, Decimal("1")), 200)

    with pytest.raises(ValidationError) as exc:
        await _produce(s, kit, user, shelf, good=350, used_by_line={line.id: 350})
    assert exc.value.code == "used_exceeds_issued"


async def test_the_clients_350g_run_is_recorded_with_the_flag(floor):
    """The fix. Same numbers, flag on: the batch posts and the material drains."""
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=True)
    line = await _line_for(s, kit, cells)
    await issue(kit, line, await stock(cells, 200, Decimal("1")), 200)

    await _produce(s, kit, user, shelf, good=350, used_by_line={line.id: 200})

    assert kit.good_qty == 350
    assert line.used_qty == 200
    assert _on_floor(line) == 0


async def test_the_under_yield_run_still_posts_with_the_flag(floor):
    """The other half of the client's pair — 200 g off the same charge.

    It always passed, and must keep passing: relaxing a floor must not introduce
    a ceiling.
    """
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=True)
    line = await _line_for(s, kit, cells)
    await issue(kit, line, await stock(cells, 200, Decimal("1")), 200)

    await _produce(s, kit, user, shelf, good=200, used_by_line={line.id: 200})

    assert kit.good_qty == 200
    assert _on_floor(line) == 0


async def test_two_runs_off_identical_material_may_yield_differently(floor):
    """The requirement in one test: same recipe, same charge, different results."""
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    made_each = []
    for target in (200, 350):
        kit = await make_kit(variable_yield=True)
        line = await _line_for(s, kit, cells)
        await issue(kit, line, await stock(cells, 200, Decimal("1")), 200)
        await _produce(s, kit, user, shelf, good=target, used_by_line={line.id: 200})
        made_each.append(kit.good_qty)
    assert made_each == [200, 350]


# ── 4b. The recipe still sets a floor — it just stops scaling ───────────
#
# The first cut of this feature dropped `used_below_need` outright, and the user
# caught it on the close-out screen: every component sat at Used 0 and the batch
# was accepted, producing output from no material at all. That made the BOM
# decorative, which is the same objection that corrected KIT-003.
#
# The rule is narrower. What is wrong for a grown item is that the OUTPUT sets
# the input requirement. The recipe still says what one run takes — CR 1, AY 2 —
# and that stays the minimum however much comes out.


async def test_a_batch_cannot_be_produced_from_no_material(floor):
    """The hole the user found. Used 0 on every line must not make 350 units."""
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=True)
    line = await _line_for(s, kit, cells)
    await issue(kit, line, await stock(cells, 200, Decimal("1")), 200)

    with pytest.raises(ValidationError) as exc:
        await _produce(s, kit, user, shelf, good=350, used_by_line={line.id: 0})
    assert exc.value.code == "used_below_need"


async def test_the_floor_is_one_runs_worth_of_the_recipe(floor):
    """`qty_per_unit` 2 → a run takes 2, whatever it yields. 1 is refused, 2 posts.

    The number does NOT scale with the 350 units being claimed — that scaling is
    exactly what YLD-001 removed.
    """
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=True)
    line = await _line_for(s, kit, cells, qty_per_unit="2.000")
    await issue(kit, line, await stock(cells, 200, Decimal("1")), 200)

    with pytest.raises(ValidationError) as exc:
        await _produce(s, kit, user, shelf, good=350, used_by_line={line.id: 1})
    assert exc.value.code == "used_below_need"

    await _produce(s, kit, user, shelf, good=350, used_by_line={line.id: 2})
    assert kit.good_qty == 350


async def test_every_component_carries_its_own_floor(floor):
    """One line short fails the batch even when the other is satisfied."""
    s, user, shelf, cells, reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=True)
    line_a = await _line_for(s, kit, cells, line_no=1, qty_per_unit="1.000")
    line_b = await _line_for(s, kit, reagent, line_no=2, qty_per_unit="2.000")
    await issue(kit, line_a, await stock(cells, 200, Decimal("1")), 200)
    await issue(kit, line_b, await stock(reagent, 10, Decimal("1")), 10)

    with pytest.raises(ValidationError) as exc:
        await _produce(
            s, kit, user, shelf, good=350, used_by_line={line_a.id: 5, line_b.id: 1}
        )
    assert exc.value.code == "used_below_need"


async def test_a_batch_that_makes_nothing_is_held_to_nothing(floor):
    """`good=0` still finalises — a failed run must stay closeable.

    `attempted == 0` zeroes the floor on any kit, so introducing a per-run
    minimum must not turn a good=0 close-out into a 422.
    """
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=True)
    line = await _line_for(s, kit, cells, qty_per_unit="2.000")
    await issue(kit, line, await stock(cells, 200, Decimal("1")), 200)

    await _produce(s, kit, user, shelf, good=0, used_by_line={line.id: 0})

    assert (kit.good_qty or 0) == 0


# ── 4c. What the flag must NOT relax ────────────────────────────────────
#
# The obvious way to get this wrong is a flag that switches off the whole
# pre-flight. These gates are physical rather than recipe-derived, and every one
# of them still fires.


async def test_the_flag_does_not_allow_using_material_that_is_not_there(floor):
    """``used_exceeds_issued`` is about the floor, not the recipe. It stands."""
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=True)
    line = await _line_for(s, kit, cells)
    await issue(kit, line, await stock(cells, 50, Decimal("1")), 50)

    with pytest.raises(ValidationError) as exc:
        await _produce(s, kit, user, shelf, good=350, used_by_line={line.id: 51})
    assert exc.value.code == "used_exceeds_issued"


async def test_the_flag_does_not_remove_the_requirement_to_record_usage(floor):
    """``used_qty_missing`` — no silent default. The paper record still drives it."""
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=True)
    line = await _line_for(s, kit, cells)
    await issue(kit, line, await stock(cells, 200, Decimal("1")), 200)

    with pytest.raises(ValidationError) as exc:
        await _produce(s, kit, user, shelf, good=350, used_by_line={})
    assert exc.value.code == "used_qty_missing"


async def test_every_component_is_still_checked_not_just_the_first(floor):
    """A second line with nothing recorded still stops the batch."""
    s, user, shelf, cells, reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=True)
    line_a = await _line_for(s, kit, cells, line_no=1)
    line_b = await _line_for(s, kit, reagent, line_no=2)
    await issue(kit, line_a, await stock(cells, 200, Decimal("1")), 200)
    await issue(kit, line_b, await stock(reagent, 10, Decimal("1")), 10)

    with pytest.raises(ValidationError) as exc:
        await _produce(s, kit, user, shelf, good=350, used_by_line={line_a.id: 200})
    assert exc.value.code == "used_qty_missing"


async def test_an_ordinary_kit_is_completely_unaffected(floor):
    """The regression guard. Nothing about a normal build changes."""
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=False, target_qty=4)
    line = await _line_for(s, kit, cells, qty_per_unit="2.000")
    await issue(kit, line, await stock(cells, 20, Decimal("1")), 20)

    # 3 attempted × 2 per unit = 6 needed; 5 is short, exactly as before.
    with pytest.raises(ValidationError) as exc:
        await _produce(s, kit, user, shelf, good=3, used_by_line={line.id: 5})
    assert exc.value.code == "used_below_need"

    await _produce(s, kit, user, shelf, good=3, used_by_line={line.id: 6})
    assert kit.good_qty == 3


async def test_scrap_no_longer_raises_the_bar_on_a_grown_item(floor):
    """``attempted`` is good + scrap, and neither term binds the input any more."""
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=True)
    line = await _line_for(s, kit, cells)
    await issue(kit, line, await stock(cells, 200, Decimal("1")), 200)

    await _produce(s, kit, user, shelf, good=300, scrap=50, used_by_line={line.id: 200})

    assert kit.good_qty == 300
    assert kit.scrap_qty == 50


# ── 4d. The money follows the real yield ────────────────────────────────


async def test_the_produced_lot_is_priced_off_the_actual_yield(floor):
    """$2/unit × 200 units of material = $400, over 350 made.

    Nothing in ``costing`` was touched for this requirement; the point of the
    assertion is that the untouched code lands on the right number when handed a
    yield the software previously refused.
    """
    s, user, shelf, cells, _reagent, make_kit, stock, issue = floor
    kit = await make_kit(variable_yield=True)
    line = await _line_for(s, kit, cells)
    await issue(kit, line, await stock(cells, 200, Decimal("2")), 200)

    await _produce(s, kit, user, shelf, good=350, used_by_line={line.id: 200})

    await s.refresh(kit, attribute_names=["batches"])
    batch = kit.batches[-1]
    assert batch.material_cost_amount == Decimal("400.000000")
    assert batch.unit_cost_amount == costing.output_unit_cost(Decimal("400"), 350)
