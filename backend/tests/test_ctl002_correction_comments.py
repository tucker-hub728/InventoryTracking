"""A correction is visible in the ledger, with the operator's comment (CTL-002).

    "Error correction shall be performed by re-kitting/re-receiving with
    explanatory comments so the correction is visible in the ledger, rather
    than by silent edits; the free-text comment/sign-off field on close-out
    and moves supports this."
    — CellReady SRS Consolidated Amendment 9+10, v2 rev. 2026-08-18

Most of CTL-002 was already true by construction and is tested elsewhere: the
ledger is append-only (``tg_stock_movements_no_update/no_delete``), so a
correction can only ever *be* a new counter-movement, and the re-kitting doors
themselves — return excess, cancel, re-issue — already exist.

What did not hold is the second half of the sentence: **every signed kitting
write took a ``reason``, but only ``return`` and ``cancel`` put it on the ledger
row.** Close-out and produce accepted the comment and dropped it — the
operator's "re-run after the wrong component went in" survived on the signature
row and nowhere a reader of the item's movement history would see it. That is
what this file pins.

The comment itself stays **optional** (client, 2026-06-29 — no e-signature
requires one), which is why the note builder has a blank-reason twin: the fix
must add the rationale when there is one and change nothing when there is not.

## The receiving half, and the movement that is NOT written

``PATCH /v1/lots/{id}`` can correct a received quantity, and it deliberately
writes **no stock movement** — see ``test_lot_update_writes_no_stock_movement``
for the full reasoning. Briefly: ``ordered_qty`` is what *arrived*, while every
ledger unit-IN is written by *placement*, so posting the delta credits stock
that is in no location and double-counts once those units are placed. The
re-receiving CTL-002 names is the placement itself — a real ``receipt`` row with
a real location and its own signature. The lot edit stays signed and audited
(before/after plus the comment) via ``record_entity_change``.

Tested at the unit/wiring level rather than over HTTP, the same way
``test_kit_super_admin_control.py`` is: driving a close-out for real needs a
live password, a reauth ticket, a production node, a BOM and lot allocations,
none of which is what CTL-002 is about. The end-to-end paths are
``smoke_kitting.py`` and ``smoke_tiered_uom.py``.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest
from app.inventory import routes as inventory_routes
from app.kitting import routes as kitting_routes
from app.kitting.routes import _with_reason

# ── 1. The note builder ────────────────────────────────────────────────


def test_reason_is_appended_to_the_ledger_note() -> None:
    assert (
        _with_reason("Issued 10, used 5, backflushed 5", "Wrong lot picked")
        == "Issued 10, used 5, backflushed 5 — Wrong lot picked"
    )


@pytest.mark.parametrize("reason", ["", None])
def test_a_blank_reason_leaves_the_note_exactly_as_it_was(reason: str | None) -> None:
    """The comment is optional, so signing without one must not leave the
    ledger note ending in a dangling em dash."""
    assert _with_reason("Backflushed 5", reason) == "Backflushed 5"


# ── 2. Every signed kitting ledger write carries the comment ───────────

#: The two helpers that write a ledger row on behalf of a *signed* kitting
#: action. ``_move_to_production`` is deliberately absent: issue and additional
#: issue are not e-signed (``IssueRequest`` carries no ``evidence_id``), so
#: there is no comment at those call sites to forward.
SIGNED_LEDGER_HELPERS = ("_produce_batch", "_return_to_inventory")


def _called_names(node: ast.AST) -> set[str]:
    """Every function name called anywhere inside ``node``."""
    names: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Call):
            fn = child.func
            name = fn.id if isinstance(fn, ast.Name) else getattr(fn, "attr", None)
            if name:
                names.add(name)
    return names


def _handlers_writing_signed_ledger_rows() -> list[ast.AsyncFunctionDef]:
    source = Path(inspect.getfile(kitting_routes)).read_text(encoding="utf-8")
    tree = ast.parse(source)
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef)
        and node.name not in SIGNED_LEDGER_HELPERS
        and _called_names(node) & set(SIGNED_LEDGER_HELPERS)
    ]


def _is_with_reason(node: ast.AST) -> bool:
    return isinstance(node, ast.Call) and getattr(node.func, "id", None) == "_with_reason"


def _note_sites() -> list[tuple[str, int, bool]]:
    """``(handler, line, threaded)`` for every ``note=`` on a signed ledger write.

    Checked per call site, not per handler: ``close_out_kit`` writes two ledger
    rows (the produced batch and the back-flush) and ``return_excess`` two more,
    so a handler-level check would still pass with one of its sites regressed.

    A note reaches the helper either inline (``note=_with_reason(...)``) or via
    a local built just above the loop (``note = _with_reason(...)`` then
    ``note=note``) — both are threaded, anything else is not.
    """
    sites: list[tuple[str, int, bool]] = []
    for handler in _handlers_writing_signed_ledger_rows():
        threaded_locals = {
            target.id
            for stmt in ast.walk(handler)
            if isinstance(stmt, ast.Assign) and _is_with_reason(stmt.value)
            for target in stmt.targets
            if isinstance(target, ast.Name)
        }
        for call in ast.walk(handler):
            if not isinstance(call, ast.Call):
                continue
            fn = call.func
            name = fn.id if isinstance(fn, ast.Name) else getattr(fn, "attr", None)
            if name not in SIGNED_LEDGER_HELPERS:
                continue
            for kw in call.keywords:
                if kw.arg != "note":
                    continue
                threaded = _is_with_reason(kw.value) or (
                    isinstance(kw.value, ast.Name) and kw.value.id in threaded_locals
                )
                sites.append((handler.name, call.lineno, threaded))
    return sites


def test_every_signed_kitting_ledger_note_carries_the_reason() -> None:
    """The regression guard, not just a test of today's six call sites.

    This is the CTL-002 twin of the "fourth return door" test in
    ``test_kit_super_admin_control.py``. A new signed door — a bulk return, an
    "undo issue", a second produce path — that writes a ledger row without
    threading the operator's comment through fails here, rather than shipping
    and quietly losing the rationale on that one flow.
    """
    sites = _note_sites()
    assert sites, (
        "No note= call sites found on _produce_batch/_return_to_inventory — the "
        "helpers were probably renamed, and this guard no longer guards anything."
    )

    offenders = [f"{name}() at line {line}" for name, line, ok in sites if not ok]
    assert not offenders, (
        "These signed kitting ledger writes drop the e-signature comment, so "
        "the operator's explanation never reaches stock_movements.notes "
        "(CTL-002): " + ", ".join(offenders)
    )


def test_the_four_signed_kitting_doors_are_all_covered() -> None:
    """Names the doors explicitly so *removing* a fixed site is a failure too,
    not a silently smaller set for the test above to pass on."""
    assert {h.name for h in _handlers_writing_signed_ledger_rows()} == {
        "produce_kit",
        "close_out_kit",
        "return_excess",
        "cancel_kit",
    }
    # produce ×1, close-out ×2 (batch + back-flush), return ×2 (multi-lot and
    # single-source), cancel ×1.
    assert len(_note_sites()) == 6


# ── 3. The lot quantity correction ─────────────────────────────────────


def _update_lot() -> ast.AsyncFunctionDef:
    tree = ast.parse(Path(inspect.getfile(inventory_routes)).read_text(encoding="utf-8"))
    return next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "update_lot"
    )


def test_lot_update_writes_no_stock_movement() -> None:
    """Correcting ``ordered_qty`` must NOT post a movement. This is the guard on
    a bug that shipped for one day (2026-08-28) and was caught in the UI.

    ``ordered_qty`` is what ARRIVED. Every ledger unit-IN is written by
    *placement* — ``sum_received_qty_for_lot`` puts it plainly: "place is the
    sole writer". So correcting 360 to 420 does not make 60 units exist, it
    makes 60 units *placeable*.

    Posting the delta anyway credited stock sitting in no location — an
    ``Adjusted +60`` row with a blank Location while every neighbouring row
    named one — and double-counted: placing those 60 writes its own
    ``receipt +60``, so a 420-unit lot reported 480. On the real dev lot the
    ledger read 396 on hand against 360 ever received.

    The correction is still signed and audited (``record_entity_change``, with
    before/after and the comment); the re-receiving CTL-002 names is the
    placement of the extra units, which writes a real ``receipt`` row with a
    real location.
    """
    called = _called_names(_update_lot())
    writers = sorted(
        name
        for name in called
        if "movement" in name.lower() or name == "StockMovement"
    )
    assert not writers, (
        "update_lot writes a stock movement again "
        f"({', '.join(writers)}) — see this test's docstring: it credits stock "
        "that is in no location and double-counts once the units are placed."
    )


# ── 4. The floor a correction may not go under ─────────────────────────


def _call_lines(fn: ast.AST, name: str) -> list[int]:
    return [
        node.lineno
        for node in ast.walk(fn)
        if isinstance(node, ast.Call)
        and (
            getattr(node.func, "id", None) == name
            or getattr(node.func, "attr", None) == name
        )
    ]


def test_the_correction_floor_counts_units_that_were_already_used() -> None:
    """Consumption must not lower the floor under a spent lot.

    ``sum_active_alloc_qty_for_lot`` shrinks when material is used;
    ``sum_received_qty_for_lot`` does not — which is exactly why every
    placement path in ``locations/routes.py`` caps against the latter
    (``place_exceeds_ordered``). Guarding the lot edit with only the shrinking
    sum let 360-received-300-consumed be "corrected" to 60: below the 360 the
    placement paths still believe were received to inventory, leaving the
    availability endpoint reporting negative remaining capacity.
    """
    called = _called_names(_update_lot())
    assert "sum_received_qty_for_lot" in called, (
        "update_lot no longer checks the lifetime received-to-inventory floor, "
        "so consumed units can lower it — see this test's docstring."
    )
    assert "sum_active_alloc_qty_for_lot" in called, (
        "update_lot no longer checks what is currently placed; that is the "
        "floor the operator CAN clear by unplacing, and its message says so."
    )


def test_the_unworkaroundable_floor_is_checked_first() -> None:
    """Order matters for the message, not just the outcome.

    Both floors raise ``qty_below_placed``, but only one is actionable: a lot
    can be unplaced, it cannot be un-consumed. Checking the lifetime floor
    first means an operator who is under both is told the truth ("cannot be
    corrected below N") rather than being sent to unplace units that would not
    help.
    """
    fn = _update_lot()
    lifetime = _call_lines(fn, "sum_received_qty_for_lot")
    current = _call_lines(fn, "sum_active_alloc_qty_for_lot")
    assert lifetime and current
    assert min(lifetime) < min(current)
