"""The counting correction: adjust one (lot × location) in or out (CTL-002).

    "Error correction shall be performed by re-kitting/re-receiving with
    explanatory comments so the correction is visible in the ledger, rather
    than by silent edits."
    — CellReady SRS Consolidated Amendment 9+10, v2 rev. 2026-08-18

``POST /v1/allocations/adjust`` is the discrepancy an operator actually meets:
the shelf holds 58 where the record says 60, or three vials turn up that were
never recorded. It posts one signed ``adjustment`` movement against the place
the discrepancy is, so the ledger row names a location.

Not a new concept — ``POST /movements/adjustment`` existed with a signed
``qty_delta`` until ``895a645`` removed it along with the legacy flat
locations. ``adjustment`` survived in ``MOVEMENT_TYPES``, and is still the one
type exempt from both ``ck_movements_type_sign`` and ``ck_movements_locations``
(``issue01``) — which is exactly what a correction needs: either direction, and
only one side of the move.

Two things this must never become, both guarded below:

  * **An edit of the lot's received quantity.** ``ordered_qty`` records what
    ARRIVED and is the cap every placement path measures against. A miscount
    months later does not change it. The first attempt at CTL-002 moved that
    number instead and produced an ``Adjusted +60`` row with a blank Location
    that double-counted once the units were placed — see
    ``test_ctl002_correction_comments.py``.
  * **A second receiving door.** Adjusting IN is not capped by ``ordered_qty``
    (finding more than the paperwork claimed is the whole point), so it is
    gated on the lot having been received to inventory at all. That gate is
    placement, never ``release_state``: the state is a label (STS-003), a
    signed decision can move it back to quarantine, and a partial receipt stays
    quarantined while holding real material.

Schema rules are tested directly, the movement builder against a stub session,
and the route by reading its wiring — the same approach as
``test_kit_super_admin_control.py``, for the same reason: driving this endpoint
for real needs a live password, a reauth ticket, a node and allocations, none
of which is what these rules are about. The live path is
``smoke_stock_adjust.py``.
"""

from __future__ import annotations

import ast
import inspect
import uuid
from pathlib import Path

import pytest
from app.locations import routes as location_routes
from app.locations.repository import create_node_adjustment_movement
from app.locations.schemas import StockAdjustRequest
from pydantic import ValidationError as PydanticValidationError

NODE = str(uuid.uuid4())
LOT = str(uuid.uuid4())
EVIDENCE = str(uuid.uuid4())


def _payload(**kw) -> dict:
    base = {
        "lot_id": LOT,
        "node_id": NODE,
        "direction": "out",
        "qty": 2,
        "evidence_id": EVIDENCE,
    }
    return {**base, **kw}


# ── 1. Schema rules ────────────────────────────────────────────────────


def test_a_flat_adjustment_needs_no_cells() -> None:
    req = StockAdjustRequest(**_payload(direction="in", qty=3))
    assert req.qty == 3
    assert req.cells == [] and req.cell_allocation_ids == []


@pytest.mark.parametrize("qty", [0, -1])
def test_quantity_is_how_many_never_which_way(qty: int) -> None:
    """Direction is a field, so the quantity is always positive. A signed qty
    would make "in" with a negative number mean the opposite of what it says."""
    with pytest.raises(PydanticValidationError):
        StockAdjustRequest(**_payload(qty=qty))


def test_taking_out_names_vials_not_free_positions() -> None:
    with pytest.raises(PydanticValidationError, match="free positions"):
        StockAdjustRequest(
            **_payload(direction="out", qty=1, cells=[{"grid_row": 1, "grid_col": 1}])
        )


def test_putting_in_names_free_positions_not_vials() -> None:
    with pytest.raises(PydanticValidationError, match="vials to take OUT"):
        StockAdjustRequest(
            **_payload(direction="in", qty=1, cell_allocation_ids=[str(uuid.uuid4())])
        )


def test_a_box_quantity_is_the_number_of_positions_in() -> None:
    """For LN2 the count is a consequence of the selection, never a typed
    number that can disagree with it (``uq_lot_allocations_cell``)."""
    with pytest.raises(PydanticValidationError, match="quantity is the number of vials"):
        StockAdjustRequest(
            **_payload(
                direction="in",
                qty=3,
                cells=[{"grid_row": 1, "grid_col": 1}, {"grid_row": 1, "grid_col": 2}],
            )
        )


def test_a_box_quantity_is_the_number_of_vials_out() -> None:
    with pytest.raises(PydanticValidationError, match="quantity is the number of vials"):
        StockAdjustRequest(
            **_payload(direction="out", qty=3, cell_allocation_ids=[str(uuid.uuid4())])
        )


def test_the_same_position_cannot_be_filled_twice() -> None:
    with pytest.raises(PydanticValidationError, match="distinct"):
        StockAdjustRequest(
            **_payload(
                direction="in",
                qty=2,
                cells=[{"grid_row": 2, "grid_col": 2}, {"grid_row": 2, "grid_col": 2}],
            )
        )


def test_unknown_fields_are_refused() -> None:
    """``extra='forbid'`` everywhere: a client sending ``qty_delta`` (the shape
    the endpoint had before ``895a645``) must fail loudly, not silently adjust
    by the default quantity."""
    with pytest.raises(PydanticValidationError):
        StockAdjustRequest(**_payload(qty_delta=-2))


# ── 2. The ledger row ──────────────────────────────────────────────────


class _StubResult:
    def __init__(self, value: str | None) -> None:
        self._value = value

    def scalar_one_or_none(self) -> str | None:
        return self._value


class _StubSession:
    """Enough of an ``AsyncSession`` for the movement builder: ``info`` for
    ``mark_item``, ``add`` to capture the row, ``execute`` for the path walk."""

    def __init__(self, path: str = "Storage / Materials Management / Shelf A") -> None:
        self.info: dict = {}
        self.added: list = []
        self._path = path

    def add(self, obj: object) -> None:
        self.added.append(obj)

    async def flush(self) -> None:
        return None

    async def execute(self, *_args: object, **_kw: object) -> _StubResult:
        return _StubResult(self._path)


async def _movement(qty_delta: int, notes: str | None = None):
    session = _StubSession()
    node_id = uuid.uuid4()
    movement = await create_node_adjustment_movement(
        session,
        item_id=uuid.uuid4(),
        lot_id=uuid.uuid4(),
        node_id=node_id,
        qty_delta=qty_delta,
        performed_by_user_id=uuid.uuid4(),
        notes=notes,
    )
    return movement, node_id


async def test_units_found_arrive_at_the_node_from_nowhere() -> None:
    """An IN has a destination and no origin — the units were never anywhere
    else, which is the whole point of the correction."""
    movement, node_id = await _movement(3, "Adjusted 3 in at Shelf A — cycle count")

    assert movement.movement_type == "adjustment"
    assert movement.qty_delta == 3
    assert movement.qty_abs == 3
    assert movement.to_location_node_id == node_id
    assert movement.from_location_node_id is None
    assert movement.to_location_path == "Storage / Materials Management / Shelf A"
    assert movement.from_location_path is None
    assert movement.notes.endswith("cycle count")


async def test_units_missing_leave_the_node_for_nowhere() -> None:
    movement, node_id = await _movement(-2)

    assert movement.qty_delta == -2
    # ck_movements_qty_abs_positive: the magnitude is always positive.
    assert movement.qty_abs == 2
    assert movement.from_location_node_id == node_id
    assert movement.to_location_node_id is None
    assert movement.from_location_path == "Storage / Materials Management / Shelf A"
    assert movement.to_location_path is None


async def test_the_row_always_names_a_location() -> None:
    """The defect that started this: an adjustment with neither side set showed
    in the Unit Ledger as ``Adjusted +60`` against a blank Location, while every
    neighbouring row named one."""
    for delta in (5, -5):
        movement, node_id = await _movement(delta)
        assert node_id in {
            movement.from_location_node_id,
            movement.to_location_node_id,
        }
        assert movement.from_location_path or movement.to_location_path


# ── 3. What the route must and must not do ─────────────────────────────


def _called_names(node: ast.AST) -> set[str]:
    names: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Call):
            fn = child.func
            name = fn.id if isinstance(fn, ast.Name) else getattr(fn, "attr", None)
            if name:
                names.add(name)
    return names


def _adjust_route() -> ast.AsyncFunctionDef:
    tree = ast.parse(Path(inspect.getfile(location_routes)).read_text(encoding="utf-8"))
    return next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "adjust_stock"
    )


def test_taking_out_uses_the_shared_draw() -> None:
    """Transfer, shipment and material issue all take stock off a source the
    same way, and ``draw_lot_at_node`` is that one implementation — it is what
    makes a box give up the exact vials and a flat location go FIFO. A private
    copy here would drift from the other three."""
    assert "draw_lot_at_node" in _called_names(_adjust_route())


def test_an_overdraw_is_named_for_the_action_the_operator_performed() -> None:
    """``exceeds_code`` is the one thing that differs between the four draw
    callers, and the dialog matches on it to phrase its message."""
    source = Path(inspect.getfile(location_routes)).read_text(encoding="utf-8")
    assert '"adjust_exceeds_available"' in source


def test_adjusting_never_edits_the_lot() -> None:
    """The line this endpoint exists to hold.

    ``ordered_qty`` is what arrived; this corrects what is on the shelf. If
    adjusting starts writing to the lot, the two numbers stop answering
    different questions and the placement cap loses its meaning.
    """
    called = _called_names(_adjust_route())
    forbidden = called & {"apply_lot_patch", "update_lot", "set_lot_release_state"}
    assert not forbidden, (
        f"adjust_stock writes to the lot ({', '.join(sorted(forbidden))}) — it "
        "corrects what is at a location, not what arrived."
    )

    fn = _adjust_route()
    assignments = {
        target.attr
        for stmt in ast.walk(fn)
        if isinstance(stmt, ast.Assign)
        for target in stmt.targets
        if isinstance(target, ast.Attribute)
    }
    assert "ordered_qty" not in assignments
    assert "release_state" not in assignments


def test_putting_in_is_gated_on_placement_not_on_the_label() -> None:
    """STS-003: the release state is a label. It can be moved back to
    quarantine by a signed decision, and a partial receipt stays quarantined
    while holding real material — so gating on it would be both bypassable and
    wrong. The real question is whether this lot has ever been received to
    inventory, which is what ``sum_received_qty_for_lot`` answers.
    """
    called = _called_names(_adjust_route())
    assert "sum_received_qty_for_lot" in called, (
        "adjust_stock no longer checks that the lot has been received to "
        "inventory, so adjusting in has become an uncapped second receiving "
        "door that skips the ordered_qty cap and the release step."
    )
    assert "release_state" not in _read_attributes(_adjust_route()), (
        "adjust_stock reads release_state — see this test's docstring; the gate "
        "belongs on placement."
    )


def _read_attributes(fn: ast.AST) -> set[str]:
    return {
        node.attr
        for node in ast.walk(fn)
        if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load)
    }


def test_the_signature_is_consumed_last() -> None:
    """A replayed or expired ticket must roll the adjustment back with it, so
    the consume is the final step — the same ordering every signed write in
    this module uses."""
    fn = _adjust_route()
    consume = [
        node.lineno
        for node in ast.walk(fn)
        if isinstance(node, ast.Call)
        and getattr(node.func, "id", None) == "consume_reauth_evidence"
    ]
    writes = [
        node.lineno
        for node in ast.walk(fn)
        if isinstance(node, ast.Call)
        and getattr(node.func, "attr", None)
        in {"draw_lot_at_node", "create_allocation", "create_node_adjustment_movement"}
    ]
    assert consume and writes
    assert min(consume) > max(writes)
