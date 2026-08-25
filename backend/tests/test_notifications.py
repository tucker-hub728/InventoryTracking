"""NOTIF-001 — the decisions behind the notification bell.

Tested directly rather than through HTTP, for the reason
``test_planning_reorder.py`` gives: the interesting logic here is a set of pure
decisions, and reaching them over the wire needs a live API and a password. The
end-to-end path belongs in ``smoke_notifications.py``.

What is worth pinning:

* **Who gets told.** The targeting permission is the difference between five
  recipients and five hundred; getting it wrong is a write amplification bug
  that only shows up in production.
* **Edge triggering.** A low-stock alert is a state, not an event, so the
  emitter must announce a transition and stay silent on a steady state. Without
  this the hourly sweep re-announces the same items forever.
* **The threshold-zero rule**, which is what stops the first-ever run
  announcing the entire catalogue.
* **No rendered labels or colours on the wire** — the client owns those.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

import pytest
from app.consumables.repository import flag_for
from app.models.notifications import NOTIFICATION_KINDS, NOTIFICATION_SUBJECT_TABLES
from app.notifications import emitter
from app.notifications.pending import mark_issue, mark_item, take_pending
from app.security.permissions import has_permission


class _Stock:
    def __init__(self, qty: Decimal) -> None:
        self.qty_available = qty
        self.status_code = "unused"


class _Item:
    """Just enough of an ``Item`` for the pure state decision."""

    def __init__(self, qty: str, threshold: str) -> None:
        self.id = uuid.uuid4()
        self.item_number = "CR-0001"
        self.description = "Test reagent"
        self.uom = "each"
        self.reorder_threshold = Decimal(threshold)
        self.stock = _Stock(Decimal(qty))


class _Session:
    """``session.info`` is the only thing ``pending`` touches."""

    def __init__(self) -> None:
        self.info: dict = {}


# ── Who gets told ────────────────────────────────────────────────────────


def test_recipients_are_people_who_can_act_not_everyone_who_can_look():
    """``read_only`` must not receive alerts it cannot act on.

    Both actions an alert asks for — acknowledging an expiry check, receiving to
    inventory — require ``inventory:sign``. A ``read_only`` user holds only
    ``view``. Fan-out writes one row per recipient, so including them is both a
    message nobody can answer and, on the dev database, a hundredfold increase
    in rows written per event.
    """
    assert emitter.RECIPIENT_ACTION == "sign"
    for role in ("super_admin", "admin", "operator"):
        assert has_permission(role, "inventory", emitter.RECIPIENT_ACTION), role
    assert not has_permission("read_only", "inventory", emitter.RECIPIENT_ACTION)
    # …but read_only can still READ a feed, which is what the routes gate on.
    assert has_permission("read_only", "inventory", "view")


# ── Item state ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("qty", "threshold", "expected"),
    [
        ("100", "10", "available"),
        # PLN-001 verbatim: warn when on-hand *reaches* the threshold.
        ("10", "10", "low_stock"),
        ("9", "10", "low_stock"),
        ("0", "10", "out_of_stock"),
        # Negative is not a thing that should exist, but if it does it is
        # certainly not "available".
        ("-5", "10", "out_of_stock"),
    ],
)
def test_item_state_matches_the_view(qty: str, threshold: str, expected: str):
    """The same boundaries ``app.v_item_stock`` uses for ``status_code``.

    Reused rather than re-derived so the bell can never describe an item
    differently from the badge on the row it links to.
    """
    assert emitter._item_state(_Item(qty, threshold)) == expected


@pytest.mark.parametrize("threshold", ["0", "-1"])
def test_threshold_of_zero_never_alerts(threshold: str):
    """An unset threshold is not a threshold of zero.

    Without this rule every item that has never moved satisfies ``0 <= 0`` and
    the first sweep announces the whole catalogue. It mirrors
    ``planning.repository._at_or_below``, which excludes the same rows from the
    reorder screen and counts them separately.
    """
    assert emitter._item_state(_Item("0", threshold)) == "available"


# ── Expiry state ─────────────────────────────────────────────────────────


def test_expiry_kinds_cover_every_flag_the_engine_produces():
    """Each flag ``flag_for`` can return must map to a kind.

    A flag with no mapping would raise a KeyError inside the emitter, which
    ``flush_pending`` swallows — so the bell would go quiet with only a log line
    to say why.
    """
    today = date(2026, 8, 25)
    produced = {
        flag_for(d, warn_days=30, today=today)[0]
        for d in (date(2026, 8, 1), date(2026, 8, 25), date(2026, 9, 1), date(2027, 1, 1))
    }
    for flag in produced - {None}:
        assert flag in emitter._ISSUE_KINDS, flag
    assert set(emitter._ISSUE_KINDS.values()) <= set(NOTIFICATION_KINDS)


def test_every_kind_and_subject_is_one_the_check_constraint_allows():
    """Anything the emitter can write must satisfy the DB CHECK."""
    assert emitter._ITEM_KIND in NOTIFICATION_KINDS
    assert emitter.ITEM_SUBJECT in NOTIFICATION_SUBJECT_TABLES
    assert emitter.ISSUE_SUBJECT in NOTIFICATION_SUBJECT_TABLES


# ── Body contents ────────────────────────────────────────────────────────


def test_item_body_carries_facts_not_presentation():
    """No label, no colour, no tone — only ``status_code``.

    The client resolves the badge from ``STOCK_STATUS_META``. A server-supplied
    label would become a second source for something that has already rendered
    three different ways at once.
    """
    body = emitter._item_body(_Item("2", "10"), status_code="low_stock", lead_time_days=10)
    assert body["status_code"] == "low_stock"
    assert not {"label", "tone", "colour", "color", "title"} & body.keys()
    # NUMERIC is sent as a string, matching every other endpoint.
    assert body["qty_available"] == "2"
    assert body["reorder_threshold"] == "10"


def test_item_body_keeps_a_missing_lead_time_missing():
    """``None`` rather than zero. Zero reads as "delivers same day", which would
    suppress exactly the early warning the alert exists to give."""
    body = emitter._item_body(_Item("2", "10"), status_code="low_stock", lead_time_days=None)
    assert body["lead_time_days"] is None


# ── The session tagging ──────────────────────────────────────────────────


def test_pending_tags_are_per_transaction_and_drain_once():
    """``take_pending`` removes what it returns.

    Leaving the tags behind would re-evaluate them on the next request that
    reused the session object.
    """
    s = _Session()
    item_id, issue_id = uuid.uuid4(), uuid.uuid4()
    mark_item(s, item_id)
    mark_item(s, item_id)  # deduped by the set
    mark_issue(s, issue_id)

    items, issues = take_pending(s)
    assert items == {item_id}
    assert issues == {issue_id}

    # Second drain is empty — this is what makes the hook safe to call on every
    # commit, including the overwhelming majority that touched no stock.
    assert take_pending(s) == (set(), set())


def test_marking_none_is_a_no_op():
    """Several ledger helpers accept a nullable id; none of them should have to
    guard the call."""
    s = _Session()
    mark_item(s, None)
    mark_issue(s, None)
    assert take_pending(s) == (set(), set())
