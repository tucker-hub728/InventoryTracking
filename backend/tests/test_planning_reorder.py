"""Reorder signals — threshold breach and supplier lead time (PLN-001).

    "Each item shall carry a reorder threshold and a supplier lead time; the
    planning module shall warn when on-hand reaches the threshold so long-lead
    items can be reordered in time."

Like ``test_tiered_uom.py``, the failure mode here is not a crash. Every value
involved is a plausible small integer, so picking the *shortest* supplier lead
time instead of the longest, or letting a zero threshold qualify, produces a
screen that looks entirely ordinary while being wrong in the one direction that
matters: warning too late, or burying the real warnings under noise. Nothing
raises. So the decisions are tested directly rather than through HTTP.

The end-to-end path (set a threshold, draw stock down past it, see the row)
needs a live API and a password, and belongs in a smoke script.
"""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest
from app.inventory.schemas import SupplierCreate, SupplierUpdate
from app.planning import repository as plan_repo
from pydantic import ValidationError as PydanticValidationError


def _item(threshold: str, available: str | None) -> SimpleNamespace:
    """An item with a threshold and, optionally, a stock row.

    ``available=None`` models the LEFT-JOIN miss: an item that has never moved
    and so has no row in ``app.v_item_stock``.
    """
    stock = None if available is None else SimpleNamespace(qty_available=Decimal(available))
    return SimpleNamespace(reorder_threshold=Decimal(threshold), stock=stock)


def _supplier(name: str, lead: int | None) -> SimpleNamespace:
    return SimpleNamespace(name=name, lead_time_days=lead)


def _links(*suppliers: SimpleNamespace | None) -> SimpleNamespace:
    """An item whose assigned-supplier list wraps the given suppliers."""
    return SimpleNamespace(suppliers=[SimpleNamespace(supplier=s) for s in suppliers])


# ── How short are we? ──────────────────────────────────────────────────


class TestShortfall:
    def test_reports_the_gap(self) -> None:
        assert plan_repo.shortfall(_item("50", "12")) == Decimal("38")

    def test_exactly_on_the_threshold_is_zero_not_negative(self) -> None:
        # PLN-001 warns when stock *reaches* the threshold, so this item is on
        # the list — but it is short by nothing. A negative here would render
        # as a surplus on a screen that only lists items in trouble.
        assert plan_repo.shortfall(_item("50", "50")) == Decimal("0")

    def test_above_the_threshold_floors_at_zero(self) -> None:
        # Not reachable through the list query, but the helper is public and a
        # caller that skips the filter must not get a negative.
        assert plan_repo.shortfall(_item("50", "90")) == Decimal("0")

    def test_no_stock_row_counts_as_zero_on_hand(self) -> None:
        # An item that has never moved has no view row. It is short the whole
        # threshold, not short nothing.
        assert plan_repo.shortfall(_item("50", None)) == Decimal("50")

    def test_keeps_fractional_units(self) -> None:
        # reorder_threshold is NUMERIC(14,3); a consume unit can be fractional.
        assert plan_repo.shortfall(_item("2.500", "0.750")) == Decimal("1.750")


# ── Whose lead time is it? ─────────────────────────────────────────────


class TestLongestLeadSupplierName:
    """The number comes from SQL; this names the supplier behind it."""

    def test_attributes_the_longest(self) -> None:
        item = _links(_supplier("Fast Local", 7), _supplier("Overseas Mfr", 45))
        assert plan_repo.longest_lead_supplier_name(item, 45) == "Overseas Mfr"

    def test_unknown_lead_time_has_no_supplier(self) -> None:
        item = _links(_supplier("Nobody Asked", None))
        assert plan_repo.longest_lead_supplier_name(item, None) is None

    def test_skips_suppliers_without_a_lead_time(self) -> None:
        # max() ignores NULLs in SQL, so the winning number can belong to the
        # only supplier that has one.
        item = _links(_supplier("Unrecorded", None), _supplier("Known", 30))
        assert plan_repo.longest_lead_supplier_name(item, 30) == "Known"

    def test_tie_goes_to_the_first_assigned(self) -> None:
        item = _links(_supplier("First", 30), _supplier("Second", 30))
        assert plan_repo.longest_lead_supplier_name(item, 30) == "First"

    def test_zero_days_is_a_real_answer(self) -> None:
        # 0 is same-day delivery, not "unset". Confusing the two is the whole
        # reason the column is nullable.
        item = _links(_supplier("Same Day", 0))
        assert plan_repo.longest_lead_supplier_name(item, 0) == "Same Day"

    def test_no_suppliers_yields_nothing(self) -> None:
        assert plan_repo.longest_lead_supplier_name(_links(), 30) is None

    def test_survives_a_dangling_link(self) -> None:
        item = _links(None, _supplier("Real", 30))
        assert plan_repo.longest_lead_supplier_name(item, 30) == "Real"


# ── What qualifies for the list ────────────────────────────────────────


class TestReorderPredicate:
    """The two conditions in :func:`_at_or_below`, read off the compiled SQL.

    Asserting on SQL text is blunt, but both rules are single clauses that a
    later edit could drop without any test failing — and each one silently
    changes which items an operator is told to order.
    """

    @staticmethod
    def _sql() -> str:
        from app.models.inventory import Item, ItemStock
        from sqlalchemy import func, select
        from sqlalchemy.dialects import postgresql

        stmt = plan_repo._at_or_below(
            select(func.count()).select_from(Item).join(ItemStock, ItemStock.item_id == Item.id)
        )
        return str(stmt.compile(dialect=postgresql.dialect()))

    def test_warns_at_or_below_not_only_below(self) -> None:
        # "reaches the threshold" — an item sitting exactly on it must warn.
        assert "qty_available <= app.items.reorder_threshold" in self._sql()

    def test_excludes_items_with_no_threshold_set(self) -> None:
        # Without this, every never-moved item qualifies (0 <= 0) and the real
        # signals drown. Those items are counted separately and reported.
        assert "app.items.reorder_threshold > " in self._sql()

    def test_ignores_soft_deleted_items(self) -> None:
        assert "app.items.deleted_at IS NULL" in self._sql()

    def test_does_not_subtract_quantity_on_order(self) -> None:
        # Client decision 2026-08-24: an item stays on the list until stock
        # physically arrives, so a late order keeps warning instead of going
        # quiet. If on-order ever gets netted off, this is the reminder that it
        # was a deliberate choice, not an oversight.
        sql = self._sql()
        assert "on_order" not in sql
        assert "lots" not in sql


# ── The supplier column ────────────────────────────────────────────────


class TestSupplierLeadTimeValidation:
    """Bounds must match the DB CHECK (``pln01``), or a valid-looking payload
    reaches Postgres and comes back as a 500 instead of a 422."""

    def test_accepts_a_plain_lead_time(self) -> None:
        assert SupplierCreate(name="Acme", lead_time_days=30).lead_time_days == 30

    def test_omitted_means_not_recorded(self) -> None:
        assert SupplierCreate(name="Acme").lead_time_days is None

    def test_zero_is_allowed_and_is_not_none(self) -> None:
        # Same-day delivery is a real answer and must survive the round trip as
        # 0 — the moment it collapses to None it reads as "not asked yet".
        supplier = SupplierCreate(name="Acme", lead_time_days=0)
        assert supplier.lead_time_days == 0
        assert supplier.lead_time_days is not None

    def test_rejects_a_negative_lead_time(self) -> None:
        with pytest.raises(PydanticValidationError):
            SupplierCreate(name="Acme", lead_time_days=-1)

    def test_rejects_an_absurd_lead_time(self) -> None:
        # Ten years is a typo in the year column, not a supplier.
        with pytest.raises(PydanticValidationError):
            SupplierCreate(name="Acme", lead_time_days=3651)

    def test_accepts_the_upper_bound(self) -> None:
        assert SupplierCreate(name="Acme", lead_time_days=3650).lead_time_days == 3650

    def test_patch_can_clear_it(self) -> None:
        # Explicit null clears back to "not recorded"; the route patches only
        # fields that were actually set, so this must survive exclude_unset.
        patch = SupplierUpdate(lead_time_days=None)
        assert "lead_time_days" in patch.model_dump(exclude_unset=True)

    def test_patch_omitting_it_leaves_it_alone(self) -> None:
        patch = SupplierUpdate(name="Renamed")
        assert "lead_time_days" not in patch.model_dump(exclude_unset=True)

    def test_patch_rejects_out_of_range(self) -> None:
        with pytest.raises(PydanticValidationError):
            SupplierUpdate(lead_time_days=-5)
