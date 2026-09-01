"""Media is consumed to the kit and never back-flushed (REQ-2026-07-31-KIT-003).

    "In multi-day kits, consumables such as media are consumed when replaced
    and are not back-flushed. The paper record drives what was pulled; the
    software mirrors it."
    — REQ-2026-07-31-KIT-003

    "Currently the media can be added each time it is used by Issue More but
    it will be backflushed unless the amount used matches the amount issued
    when it is Kitted."
    — Blane Larson, 2026-08-31

That second quote is the defect. The procedure was already right — pull media
through "Issue more" at each feeding — but close-out then returned whatever the
operator had not typed into the ``Used`` column, and because ``backflush`` is a
CREDIT movement type the return also credited the media's cost away. Both halves
of the requirement hang on that material being consumed instead of handed back.

The mechanism is one flag, snapshotted from the item onto the kit line, and it
changes exactly one moment. **While the kit is open a flagged line is an ordinary
component** — the BOM drives its need, the operator records each feeding, and
``used_qty_missing`` / ``used_below_need`` / ``used_exceeds_issued`` all apply.
At **close-out** it consumes whatever is still on the floor instead of the
entered amount, so ``_on_floor`` reaches zero before the back-flush loop looks at
it and the value lands on the final lot like any other consumption.

That narrowing is the client's correction (2026-08-31) to a first cut which
consumed the whole floor at every batch. It was wrong twice over: it made the BOM
meaningless for media, and in a multi-day kit an early batch ate the feedings
issued for later days.

Tested at the unit / wiring level, the same way ``test_ctl002_correction_comments``
and ``test_kit_super_admin_control`` are, plus a section that drives the real
``_produce_batch`` against real rows. ``smoke_kitting.py`` would be the usual
end-to-end home, but its fixtures are hard-coded dev ids and the dev database was
reset on 2026-08-25 (0 items, 0 lots), so it cannot run at all.
"""

from __future__ import annotations

import inspect
import uuid
from decimal import Decimal

import pytest
import pytest_asyncio
from app.core.config import get_settings
from app.core.exceptions import ValidationError
from app.kitting import repository as kit_repo
from app.kitting import routes as kitting_routes
from app.kitting.routes import _line_returned, _on_floor
from app.models.identity import User
from app.models.inventory import Item, ItemPrefix, ItemTier, Lot, StockMovement
from app.models.kitting import Kit, KitBatchConsumption, KitLine, KitProductionBatch
from app.models.locations import LocationNode, LotAllocation
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

pytestmark = pytest.mark.anyio


def _line(**kw) -> KitLine:
    """An in-memory line. Never flushed — these assertions are about arithmetic."""
    defaults = {
        "line_no": 1,
        "item_id": uuid.uuid4(),
        "qty_per_unit": Decimal("1.000"),
        "consumed_in_kit": False,
        "issued_qty": 0,
        "additional_issued_qty": 0,
        "used_qty": None,
        "early_returned_qty": 0,
    }
    return KitLine(**{**defaults, **kw})


# ── 1. The number the back-flush loop reads ─────────────────────────────
#
# ``close_out_kit`` back-flushes ``_on_floor(line)`` and nothing else, so a
# media line consuming its whole floor is *exactly* what makes the requirement
# true. These pin the arithmetic that carries it.


def test_a_fully_consumed_media_line_has_nothing_left_to_back_flush():
    line = _line(consumed_in_kit=True, issued_qty=4, additional_issued_qty=6, used_qty=10)
    assert _on_floor(line) == 0
    assert _line_returned(line) == 0, "a media line must never hand anything back"


def test_the_same_line_left_partly_used_would_have_been_back_flushed():
    """The defect Blane described, stated as an assertion.

    Identical line, ``used`` set to the recipe ratio the form used to pre-fill
    instead of the whole floor: six units go back to stock and their cost is
    credited off the kit. Nothing about ``_on_floor`` changes for KIT-003 — what
    changes is that ``_produce_batch`` no longer lets ``used`` be that number.
    """
    line = _line(consumed_in_kit=True, issued_qty=4, additional_issued_qty=6, used_qty=4)
    assert _on_floor(line) == 6
    assert _line_returned(line) == 6


def test_a_media_line_that_was_never_topped_up_still_reconciles_to_zero():
    """One issue, no feedings: the floor is the initial issue and all of it goes."""
    line = _line(consumed_in_kit=True, issued_qty=7, used_qty=7)
    assert _on_floor(line) == 0


def test_a_mid_production_return_still_reduces_a_media_line():
    """``kit_return`` (CTL-001's signed correction door) stays open to media.

    A bottle pulled and never opened can be handed back — but only before the
    next batch, which consumes the rest. Here 2 of 10 were returned early and
    the remaining 8 are consumed, so the close-out still back-flushes nothing.
    """
    line = _line(consumed_in_kit=True, issued_qty=10, early_returned_qty=2, used_qty=8)
    assert _on_floor(line) == 0
    assert _line_returned(line) == 0


def test_consuming_the_whole_floor_lands_on_the_over_use_boundary():
    """``used <= issued + additional - early_returned`` — a media line sits on
    the equality, never past it, which is why ``ck_kit_lines_no_overuse`` needs
    no exception for KIT-003."""
    line = _line(
        consumed_in_kit=True, issued_qty=5, additional_issued_qty=3, early_returned_qty=1
    )
    line.used_qty = _on_floor(line)
    assert (
        line.used_qty
        == line.issued_qty + line.additional_issued_qty - line.early_returned_qty
    )


# ── 2. The three enforcement points ─────────────────────────────────────
#
# Structural guards. The arithmetic above only holds because ``_produce_batch``
# sets ``used`` to the floor, and the requirement only holds because close-out
# and cancel both decline to credit a media line back. Each is one branch, and
# each would break silently if a later refactor dropped it.


def _consults_the_flag(fn) -> bool:
    return "consumed_in_kit" in inspect.getsource(fn)


def test_produce_consults_the_flag():
    assert _consults_the_flag(kitting_routes._produce_batch)


def test_close_out_consults_the_flag():
    assert _consults_the_flag(kitting_routes.close_out_kit)


def test_cancel_consults_the_flag():
    assert _consults_the_flag(kitting_routes.cancel_kit)


def test_produce_does_not_special_case_media():
    """The flag must NOT reach ``_produce_batch``'s body.

    It did, twice, and both times the closing lot was charged for material the
    batch never used. A media line is an ordinary component to a batch; the
    difference lives entirely in ``close_out_kit``.
    """
    body = inspect.getsource(kitting_routes._produce_batch).split('"""', 2)[-1]
    assert "consumed_in_kit" not in body


def test_every_route_that_credits_stock_back_refuses_media():
    """The rule with no exception (client, 2026-09-01).

    Three routes can hand kit material back to inventory: the automatic
    close-out back-flush, the post-issue cancel, and the manual super-admin
    ``return``. All three must decline a media line, or "consumed when replaced
    and not back-flushed" has a footnote — and a footnote is what an operator
    will find by accident.

    The manual return was the last one open; it is now refused outright, which
    means a mis-issue is unrecoverable and the units are discarded at close.
    That is the deliberate price of the rule being absolute.
    """
    for fn in (
        kitting_routes.close_out_kit,
        kitting_routes.cancel_kit,
        kitting_routes.return_excess,
    ):
        assert "consumed_in_kit" in inspect.getsource(fn), fn.__name__


def test_the_manual_return_refuses_media_before_it_moves_anything():
    """The guard has to come before the destination resolution, not after.

    ``_resolve_return_destinations`` validates cells and claims them; running it
    first would let a refused return still contend for box cells.
    """
    src = inspect.getsource(kitting_routes.return_excess)
    assert "return_not_allowed_for_consumed" in src
    assert src.index("if line.consumed_in_kit:") < src.index(
        "_resolve_return_destinations"
    ), "the media guard must run before any destination is resolved"


def test_cancel_discards_media_instead_of_returning_it():
    """A cancel is not a way for poured media to become stock again.

    It must DRAIN the line, not skip it: skipping would leave the WIP
    allocations parked at a cancelled kit's production node forever and break
    the identity ``issued + additional == used + early_returned + backflushed``.
    """
    src = inspect.getsource(kitting_routes.cancel_kit)
    branch = src[src.index("if line.consumed_in_kit:") :]
    branch = branch[: branch.index("continue")]
    assert "_drain_production" in branch, "media must leave the floor on cancel"
    assert "used_qty" in branch, "and be recorded as used, not as returned"
    assert "_return_to_inventory" not in branch, "media is never credited back"
    assert "discarded_on_cancel" in branch, "and be recorded in the audit context"


def test_close_out_and_cancel_call_the_same_thing_by_the_same_name():
    """One event, one word.

    Media leaving a kit without being returned is DISCARDED, whether the kit
    closed or was cancelled. The two paths were briefly split — "wasted" at
    close, "consumed" on cancel — the sort of drift that makes an operator think
    two different things happened to the same material.
    """
    close_src = inspect.getsource(kitting_routes.close_out_kit)
    cancel_src = inspect.getsource(kitting_routes.cancel_kit)
    assert "wasted_at_close" in close_src
    assert "discarded_on_cancel" in cancel_src
    for src in (close_src, cancel_src):
        branch = src[src.index("if line.consumed_in_kit:") :]
        branch = branch[: branch.index("continue")]
        assert "discard" in branch.lower(), "both must say what they do: discard"


# ── 3. The schema ───────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def session_factory():
    """A sessionmaker on a throwaway engine, one per test.

    Same reasoning as ``test_kit_cost_persistence``: the app's global engine
    binds its pool to the first event loop it sees, and pytest-asyncio hands
    each test a fresh one.
    """
    engine = create_async_engine(str(get_settings().database_url), poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def seed(session_factory):
    """Yield ``(session, kit, item_factory)``, rolled back afterwards."""
    async with session_factory() as s:
        tag = uuid.uuid4().hex[:8]
        user = User(
            cognito_sub=f"kit003-{tag}",
            email=f"kit003-{tag}@example.invalid",
            full_name="KIT-003 fixture",
            initials="KF",
            role="super_admin",
        )
        s.add(user)
        await s.flush()
        tier = ItemTier(
            name=f"KIT-003 tier {tag}",
            type="raw_material",
            tone="neutral",
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
        )
        s.add(tier)
        await s.flush()
        prefix = ItemPrefix(
            tier_id=tier.id,
            code=f"K{tag[:4].upper()}",
            label="KIT-003 fixture",
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
        )
        s.add(prefix)
        await s.flush()
        node = LocationNode(
            node_type="room",
            code=f"K3{tag[:6].upper()}",
            name="KIT-003 floor",
            created_by_user_id=user.id,
        )
        s.add(node)
        await s.flush()

        def item(suffix: str, **kw) -> Item:
            return Item(
                prefix_id=prefix.id,
                sku_suffix=f"{suffix}{tag[:5]}",
                description=f"KIT-003 {suffix}",
                created_by_user_id=user.id,
                updated_by_user_id=user.id,
                **kw,
            )

        parent = item("FG")
        s.add(parent)
        await s.flush()
        kit = Kit(
            kit_number=f"KIT-K3-{tag}",
            item_id=parent.id,
            target_qty=1,
            status="draft",
            production_location_node_id=node.id,
            created_by_user_id=user.id,
        )
        s.add(kit)
        await s.flush()
        yield s, kit, item
        await s.rollback()


async def _add_line(s, kit, item, **kw) -> KitLine:
    line = await kit_repo.add_kit_line(
        s,
        kit_id=kit.id,
        line_no=kw.pop("line_no", 1),
        item_id=item.id,
        qty_per_unit=kw.pop("qty_per_unit", Decimal("1.000")),
        consumed_in_kit=kw.pop("consumed_in_kit", item.consumed_in_kit),
        issued_qty=kw.pop("issued_qty", 0),
        source_location_node_id=None,
    )
    await s.flush()
    return line


async def test_an_item_cannot_be_both_a_consumable_and_consumed_to_the_kit(seed):
    """The twin is by definition the NON-consumable one.

    An item that were both would be barred from a BOM by
    ``_require_eligible_child`` — the only place the flag means anything — so
    the pair is contradictory rather than merely odd.
    """
    s, _kit, item = seed
    s.add(item("BOTH", is_consumable=True, consumed_in_kit=True))
    with pytest.raises(IntegrityError) as exc:
        await s.flush()
    assert "ck_items_consumable_xor_consumed_in_kit" in str(exc.value)
    await s.rollback()


async def test_either_flag_alone_is_accepted(seed):
    s, _kit, item = seed
    consumable = item("CONS", is_consumable=True)
    twin = item("TWIN", consumed_in_kit=True)
    s.add_all([consumable, twin])
    await s.flush()
    assert consumable.is_consumable and not consumable.consumed_in_kit
    assert twin.consumed_in_kit and not twin.is_consumable


async def test_an_item_defaults_to_neither(seed):
    """Nothing in the catalogue becomes media by accident — the migration
    deliberately backfills nothing."""
    s, _kit, item = seed
    plain = item("PLAIN")
    s.add(plain)
    await s.flush()
    await s.refresh(plain)
    assert plain.consumed_in_kit is False


async def test_add_kit_line_snapshots_the_flag(seed):
    """The line carries its own copy, so editing the item later cannot change
    how an already-open kit reconciles."""
    s, kit, item = seed
    media = item("MEDIA", consumed_in_kit=True)
    s.add(media)
    await s.flush()
    line = await _add_line(s, kit, media)
    assert line.consumed_in_kit is True

    # Un-flag the ITEM. The line must not follow it.
    media.consumed_in_kit = False
    await s.flush()
    await s.refresh(line)
    assert line.consumed_in_kit is True, "the snapshot must not track the item"


async def test_the_snapshot_survives_a_round_trip(seed):
    s, kit, item = seed
    media = item("RT", consumed_in_kit=True)
    s.add(media)
    await s.flush()
    line = await _add_line(s, kit, media, qty_per_unit=Decimal("2.000"))
    s.expunge(line)
    fetched = (await s.execute(select(KitLine).where(KitLine.id == line.id))).scalar_one()
    assert fetched.consumed_in_kit is True


async def test_a_plain_component_line_is_not_flagged(seed):
    """The flag reaches the line from the item, not from a default."""
    s, kit, item = seed
    plain = item("COMP")
    s.add(plain)
    await s.flush()
    line = await _add_line(s, kit, plain)
    assert line.consumed_in_kit is False


async def test_the_over_use_check_still_refuses_more_than_the_floor(seed):
    """Consuming the whole floor is the boundary, not a licence to exceed it.

    ``ck_kit_lines_no_overuse`` is untouched by KIT-003 and must stay so — a
    media line lands exactly on it, and one unit past is still a violation.
    """
    s, kit, item = seed
    media = item("OVER", consumed_in_kit=True)
    s.add(media)
    await s.flush()
    line = await _add_line(s, kit, media, issued_qty=5)
    await s.execute(
        text("UPDATE app.kit_lines SET used_qty = 5 WHERE id = :i"), {"i": line.id}
    )
    with pytest.raises(IntegrityError) as exc:
        await s.execute(
            text("UPDATE app.kit_lines SET used_qty = 6 WHERE id = :i"), {"i": line.id}
        )
    assert "ck_kit_lines_no_overuse" in str(exc.value)
    await s.rollback()


# ── 4. Driving the real thing ───────────────────────────────────────────
#
# ``smoke_kitting.py`` is the usual end-to-end home for this, but its fixtures
# are hard-coded dev ids and the dev database was reset on 2026-08-25 (0 items,
# 0 lots), so it cannot run at all right now. These seed everything they need in
# a rolled-back transaction and call ``_produce_batch`` — the real function, the
# real drain, the real cost attribution — so the requirement is proven against
# the code that ships rather than against a description of it.
#
# What they cannot reach is the HTTP layer: ``close_out_kit`` wants a reauth
# ticket and a live password. But the back-flush loop inside it iterates
# ``_on_floor(line)`` and back-flushes exactly that, so a media line at zero
# after the batch IS "nothing is back-flushed" — asserted below, alongside a
# normal line that still has a leftover to prove the zero means something.


@pytest_asyncio.fixture
async def floor(session_factory):
    """A kit on a production floor with one media line and one ordinary line,
    both stocked as WIP, plus a shelf for the output. Rolled back."""
    async with session_factory() as s:
        tag = uuid.uuid4().hex[:8]
        user = User(
            cognito_sub=f"kit003e2e-{tag}",
            email=f"kit003e2e-{tag}@example.invalid",
            full_name="KIT-003 e2e",
            initials="KE",
            role="super_admin",
        )
        s.add(user)
        await s.flush()
        tier = ItemTier(
            name=f"KIT-003 e2e tier {tag}",
            type="raw_material",
            tone="neutral",
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
        )
        s.add(tier)
        await s.flush()
        prefix = ItemPrefix(
            tier_id=tier.id,
            code=f"E{tag[:4].upper()}",
            label="KIT-003 e2e",
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
        )
        s.add(prefix)
        await s.flush()

        def node(name: str) -> LocationNode:
            return LocationNode(
                node_type="room",
                code=f"E3{name}{tag[:5].upper()}",
                name=f"KIT-003 {name}",
                created_by_user_id=user.id,
            )

        prod, shelf = node("PRD"), node("SHF")
        s.add_all([prod, shelf])
        await s.flush()

        def item(suffix: str, **kw) -> Item:
            return Item(
                prefix_id=prefix.id,
                sku_suffix=f"{suffix}{tag[:5]}",
                description=f"KIT-003 {suffix}",
                created_by_user_id=user.id,
                updated_by_user_id=user.id,
                **kw,
            )

        parent = item("AY")
        media = item("MEDIA", consumed_in_kit=True)
        part = item("PART")
        s.add_all([parent, media, part])
        await s.flush()

        kit = Kit(
            kit_number=f"KIT-E3-{tag}",
            item_id=parent.id,
            target_qty=2,
            status="in_production",
            production_location_node_id=prod.id,
            created_by_user_id=user.id,
        )
        s.add(kit)
        await s.flush()

        async def stock(component: Item, qty: int, price: Decimal | None) -> Lot:
            """A lot of ``component`` sitting on the production floor as WIP.

            This is the state a kit is in after issuing: the units have left
            ``v_item_stock`` and are allocated to the production node.
            """
            lot = Lot(
                item_id=component.id,
                lot_number=f"E3-{tag}-{component.sku_suffix}",
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

        async def issue(line: KitLine, lot: Lot, qty: int, *, top_up: bool) -> None:
            """The ledger row an issue / Issue-more writes, and its line counter."""
            s.add(
                StockMovement(
                    item_id=lot.item_id,
                    lot_id=lot.id,
                    movement_type="kit_additional_issue" if top_up else "kit_issue",
                    qty_delta=-qty,
                    qty_abs=qty,
                    from_location_node_id=shelf.id,
                    to_location_node_id=prod.id,
                    kit_id=kit.id,
                    kit_line_id=line.id,
                    performed_by_user_id=user.id,
                )
            )
            if top_up:
                line.additional_issued_qty += qty
            else:
                line.issued_qty += qty
            await s.flush()

        yield s, kit, user, prod, shelf, media, part, stock, issue
        await s.rollback()


async def _line_for(s, kit, item, *, line_no, qty_per_unit="1.000"):
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


async def _produce(s, kit, user, shelf, *, good, used_by_line):
    """Call the real ``_produce_batch``, placing the batch on ``shelf``.

    ``kit.lines`` is a lazy relationship — the routes always arrive with it
    eager-loaded via ``_require_kit``, so it has to be materialised here before
    the pre-flight walks it, or the first access raises ``MissingGreenlet``.

    A destination and a lot number are not optional decoration: a batch making
    good units must mint a lot, and ``ck_kit_production_batches_lot_pairing``
    enforces ``(output_lot_id IS NULL) = (good_qty = 0)``.

    Note there is no media switch to pass. ``_produce_batch`` treats every line
    the same; what makes media different happens in ``close_out_kit``.
    """
    await s.refresh(kit, attribute_names=["lines"])
    await kitting_routes._produce_batch(
        s,
        kit=kit,
        good=good,
        scrap=0,
        destinations=[(shelf.id, good, [])],
        expiration_date=None,
        lot_number=f"{kit.kit_number}-{(kit.good_qty or 0) + 1}",
        used_by_line=used_by_line,
        evidence=None,
        note="KIT-003 e2e",
        current=user,
    )


# ── 4a. A batch consumes what was RECORDED against it, media or not ─────
#
# This is the half that was got wrong twice. First by consuming a media line's
# whole floor at every batch (which made the BOM meaningless and let an early
# batch eat later feedings), then by doing it at close-out (which tripled the
# closing lot's material cost with material the batch never used). A batch takes
# the operator's number. Always.


async def test_a_batch_honours_the_operators_entry_for_media(floor):
    """Twelve on the floor, 4 recorded: the other 8 stay put.

    They are waiting for the next feeding. Nothing about media changes what a
    PRODUCE does.
    """
    s, kit, user, _prod, shelf, media_item, _part, stock, issue = floor
    media_line = await _line_for(s, kit, media_item, line_no=1)
    await issue(media_line, await stock(media_item, 12, Decimal("1")), 12, top_up=False)

    await _produce(s, kit, user, shelf, good=1, used_by_line={media_line.id: 4})

    assert media_line.used_qty == 4, "the operator's entry, not the floor"
    assert _on_floor(media_line) == 8


async def test_media_is_gated_by_its_recipe_quantity(floor):
    """``used_below_need`` applies to media — this is what the BOM is FOR.

    ``qty_per_unit`` 2 × 3 units attempted needs 6; recording 5 is refused,
    exactly as for any other component.
    """
    s, kit, user, _prod, shelf, media_item, _part, stock, issue = floor
    media_line = await _line_for(s, kit, media_item, line_no=1, qty_per_unit="2.000")
    await issue(media_line, await stock(media_item, 20, Decimal("1")), 20, top_up=False)

    with pytest.raises(ValidationError) as exc:
        await _produce(s, kit, user, shelf, good=3, used_by_line={media_line.id: 5})
    assert exc.value.code == "used_below_need"


async def test_media_still_needs_an_entry(floor):
    """No silent default anywhere — ``used_qty_missing`` holds for media too."""
    s, kit, user, _prod, shelf, media_item, _part, stock, issue = floor
    media_line = await _line_for(s, kit, media_item, line_no=1)
    await issue(media_line, await stock(media_item, 5, Decimal("1")), 5, top_up=False)

    with pytest.raises(ValidationError) as exc:
        await _produce(s, kit, user, shelf, good=1, used_by_line={})
    assert exc.value.code == "used_qty_missing"


async def test_media_cannot_be_over_consumed_either(floor):
    """``used_exceeds_issued`` is physical and applies unchanged."""
    s, kit, user, _prod, shelf, media_item, _part, stock, issue = floor
    media_line = await _line_for(s, kit, media_item, line_no=1)
    await issue(media_line, await stock(media_item, 3, Decimal("1")), 3, top_up=False)

    with pytest.raises(ValidationError) as exc:
        await _produce(s, kit, user, shelf, good=1, used_by_line={media_line.id: 4})
    assert exc.value.code == "used_exceeds_issued"


# ── 4b. The lot is charged for what the batch took, and no more ─────────


async def test_the_lot_is_charged_only_what_the_batch_recorded(floor):
    """The client's correction, in money (2026-09-01).

    50 media at $0.265 and 50 of a part at $0.04 on the floor; the closing batch
    records 20 of each. The lot must cost 20 × both = $6.10. Pouring the media
    remainder in — the previous behaviour — made it $14.05 and billed the
    customer for 30 units of media the batch never used.
    """
    s, kit, user, _prod, shelf, media_item, part_item, stock, issue = floor
    media_line = await _line_for(s, kit, media_item, line_no=1)
    part_line = await _line_for(s, kit, part_item, line_no=2)
    await issue(media_line, await stock(media_item, 50, Decimal("0.265")), 50, top_up=False)
    await issue(part_line, await stock(part_item, 50, Decimal("0.04")), 50, top_up=False)

    await _produce(
        s,
        kit,
        user,
        shelf,
        good=20,
        used_by_line={media_line.id: 20, part_line.id: 20},
    )

    batch = (
        await s.execute(select(KitProductionBatch).where(KitProductionBatch.kit_id == kit.id))
    ).scalar_one()
    assert batch.material_cost_amount == Decimal("6.100000")
    assert batch.unit_cost_amount == Decimal("0.305000")

    rows = (
        (
            await s.execute(
                select(KitBatchConsumption).where(KitBatchConsumption.batch_id == batch.id)
            )
        )
        .scalars()
        .all()
    )
    media_row = next(r for r in rows if r.kit_line_id == media_line.id)
    assert media_row.qty == 20, "not the 50 on the floor"
    assert media_row.extended_value_amount == Decimal("5.300000")

    # And the remainder is still on the floor at this point — discarding it is
    # the close-out's job, not the batch's.
    assert _on_floor(media_line) == 30


async def test_each_batch_carries_only_what_it_recorded(floor):
    """Multi-day: batch 1 must not eat what batch 2 will need."""
    s, kit, user, _prod, shelf, media_item, _part, stock, issue = floor
    media_line = await _line_for(s, kit, media_item, line_no=1)
    await issue(media_line, await stock(media_item, 10, Decimal("2")), 10, top_up=False)

    await _produce(s, kit, user, shelf, good=1, used_by_line={media_line.id: 4})
    await _produce(s, kit, user, shelf, good=1, used_by_line={media_line.id: 6})

    batches = (
        (
            await s.execute(
                select(KitProductionBatch)
                .where(KitProductionBatch.kit_id == kit.id)
                .order_by(KitProductionBatch.batch_no)
            )
        )
        .scalars()
        .all()
    )
    assert [b.material_cost_amount for b in batches] == [
        Decimal("8.000000"),
        Decimal("12.000000"),
    ]


# ── 4c. What the close-out then does with the remainder ─────────────────
#
# ``close_out_kit`` itself needs a reauth ticket and a live password, so the
# discard is pinned structurally plus by the arithmetic it performs. The rule it
# implements: drain the remainder off the floor, add it to ``used_qty``, write no
# movement and no batch row, and charge it to no lot.


def test_the_close_out_discards_the_media_remainder():
    src = inspect.getsource(kitting_routes.close_out_kit)
    branch = src[src.index("if line.consumed_in_kit:") :]
    branch = branch[: branch.index("continue")]
    assert "_drain_production" in branch, "the remainder must leave the floor"
    assert "used_qty" in branch, "and be recorded as gone"
    assert "_return_to_inventory" not in branch, "never handed back to inventory"
    assert "wasted_at_close" in branch, "and be recorded in the audit context"


def test_the_discard_happens_after_the_batch_not_inside_it():
    """The ordering that keeps the lot's cost honest.

    ``_produce_batch`` must not know about media at all — if the discard moved
    inside it, the remainder would land in ``consume`` and be attributed to the
    closing lot again, which is the bug this replaced.
    """
    src = inspect.getsource(kitting_routes._produce_batch)
    assert "consumed_in_kit" not in src.split('"""', 2)[-1], (
        "_produce_batch must treat a media line exactly like any other"
    )


def test_discarding_the_remainder_reconciles_the_line_to_zero():
    """What the close-out's arithmetic comes to.

    Issued 50, the batch recorded 20, so 30 is discarded: ``used_qty`` reaches
    the full 50 and nothing is left for the back-flush loop — which is how the
    kit closes with no stranded WIP and no return.
    """
    line = _line(consumed_in_kit=True, issued_qty=50, used_qty=20)
    discarded = _on_floor(line)
    assert discarded == 30

    line.used_qty += discarded
    assert _on_floor(line) == 0
    assert _line_returned(line) == 0
    # And still inside ``ck_kit_lines_no_overuse``.
    assert line.used_qty <= line.issued_qty + line.additional_issued_qty


def test_the_wasted_value_is_what_the_kit_was_charged_but_never_handed_to_a_lot():
    """Where the discarded money shows up, without a column to store it.

    The kit is charged for every unit issued; ``consumed_value_amount`` counts
    only what batches attributed to finished lots. Media discarded at close is
    charged and attributed to nothing, so it falls out of the difference — the
    same subtraction that means "still on the floor" while the kit is open.
    """
    charged = Decimal("50") * Decimal("0.265") + Decimal("50") * Decimal("0.04")
    returned_part = Decimal("30") * Decimal("0.04")  # the part DOES back-flush
    net_charged = charged - returned_part
    consumed_by_lots = Decimal("20") * Decimal("0.265") + Decimal("20") * Decimal("0.04")

    assert net_charged - consumed_by_lots == Decimal("30") * Decimal("0.265")
