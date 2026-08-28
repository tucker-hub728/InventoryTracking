"""Kit returns to inventory are Super-Admin-only (CTL-001).

    "A manual backfill function (returning material to inventory outside the
    automatic close-out backfill) shall be restricted to the Super Admin role
    and recorded, for use in correcting errors such as a mis-shipment."
    — CellReady SRS Consolidated Amendment 9+10, v2 rev. 2026-08-18

Scoped by the client on 2026-08-27 to the kitting module, and widened there to
the automatic back-flush as well: **every route that credits material back into
inventory is Super-Admin-only, producing is not.**

  * ``POST /kits/{id}/close-out``               — the automatic back-flush
  * ``POST /kits/{id}/lines/{lid}/return``      — the manual TRX-008 return
  * ``POST /kits/{id}/cancel``                  — a bulk return of the floor
  * ``POST /kits/{id}/produce``                 — NOT gated, on purpose

The tests assert the gate where it actually lives — in the route's
``dependencies`` list — rather than through HTTP. Driving these endpoints for
real needs a live password, a reauth ticket, a production node, a BOM and lot
allocations; none of that is what CTL-001 is about, and every one of those
fixtures would fail for reasons unrelated to the role. The end-to-end path is
``smoke_kitting.py``.

Reading the dependency list also catches the two ways this could regress that a
green happy-path test would not notice:

  * the gate being moved *inside* a handler, where a refused close-out would
    already have consumed the operator's signature ticket and burned it on a
    403 (the reauth row is single-use);
  * a fourth return door being added later — a bulk return, an "undo issue" —
    without the gate, which the door-inventory test below fails on.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from app.core.exceptions import AuthorizationError
from app.security.permissions import (
    SUPER_ADMIN_ROLE,
    RequirePermission,
    RequireRole,
)

# Every role the permission matrix knows. ``super_admin`` is the only one that
# may pass the CTL-001 gates; the rest are listed explicitly so adding a role to
# the matrix without deciding this question fails here.
ALL_ROLES = ("super_admin", "admin", "operator", "read_only")
NON_SUPER_ADMIN = tuple(r for r in ALL_ROLES if r != SUPER_ADMIN_ROLE)

#: Path suffix → the permission it still requires alongside the role gate.
#: The role gate does NOT replace the permission check: it answers a different
#: question ("is this caller allowed this action") from ("may this caller write
#: inventory at all"), and dropping either one widens the door.
GATED_ROUTES: dict[str, str] = {
    "/kits/{kit_id}/close-out": "sign",
    "/kits/{kit_id}/lines/{line_id}/return": "create",
    "/kits/{kit_id}/cancel": "create",
}

#: Routes that must stay open to any role holding the permission. Producing
#: consumes floor material and mints the output lot — it never credits stock
#: back — so gating it would block the floor for no CTL-001 benefit.
UNGATED_ROUTES: dict[str, str] = {
    "/kits/{kit_id}/produce": "sign",
    "/kits/{kit_id}/issue": "create",
    "/kits/{kit_id}/lines/{line_id}/additional-issue": "create",
}


@dataclass
class _User:
    """Just enough of ``app.models.identity.User`` for the gate to read."""

    role: str


def _kit_post_routes() -> dict[str, object]:
    """Every POST route under ``/kits``, keyed by path with the v1 prefix cut.

    Built from the composed app rather than from the router module so a route
    that is registered but never mounted (or mounted twice) cannot pass.
    """
    from app.core.config import get_settings
    from app.main import create_app

    prefix = get_settings().api_v1_prefix
    routes = {}
    for r in create_app().routes:
        path = getattr(r, "path", "")
        if not path.startswith(f"{prefix}/kits"):
            continue
        if "POST" not in getattr(r, "methods", set()):
            continue
        routes[path[len(prefix) :]] = r
    return routes


def _dependency_calls(route) -> list[object]:
    return [d.call for d in route.dependant.dependencies]


def _role_gates(route) -> list[RequireRole]:
    return [c for c in _dependency_calls(route) if isinstance(c, RequireRole)]


def _permissions(route) -> list[RequirePermission]:
    return [c for c in _dependency_calls(route) if isinstance(c, RequirePermission)]


# ── The gate itself ───────────────────────────────────────────────────


class TestRequireRoleGate:
    """``RequireRole`` is the whole mechanism, so test it directly."""

    @pytest.mark.asyncio
    async def test_super_admin_passes(self) -> None:
        gate = RequireRole(SUPER_ADMIN_ROLE, what="close out a kit")
        assert await gate(_User(role="super_admin")) is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize("role", NON_SUPER_ADMIN)
    async def test_every_other_role_is_refused(self, role: str) -> None:
        gate = RequireRole(SUPER_ADMIN_ROLE, what="close out a kit")
        with pytest.raises(AuthorizationError) as exc:
            await gate(_User(role=role))
        assert exc.value.code == "permission_denied"
        assert exc.value.details == {"required_roles": ["super_admin"]}

    @pytest.mark.asyncio
    async def test_admin_is_refused_too(self) -> None:
        """The one worth naming on its own.

        ``admin`` passes every other role gate in the codebase (``ADMIN_ROLES``)
        and collapses to the same frontend bucket as ``super_admin``. CTL-001
        says Super Admin, so this is exactly the boundary a future refactor
        would blur.
        """
        gate = RequireRole(SUPER_ADMIN_ROLE, what="close out a kit")
        with pytest.raises(AuthorizationError):
            await gate(_User(role="admin"))

    @pytest.mark.asyncio
    async def test_the_403_names_the_super_admin_not_an_admin(self) -> None:
        """The default message says "Only an admin can manage …", which would
        send a refused operator to an admin who cannot do it either."""
        gate = RequireRole(
            SUPER_ADMIN_ROLE,
            what="close out a kit",
            message="Only a Super Admin can close out a kit",
        )
        with pytest.raises(AuthorizationError) as exc:
            await gate(_User(role="operator"))
        assert exc.value.message == "Only a Super Admin can close out a kit"

    @pytest.mark.asyncio
    async def test_the_default_message_is_unchanged_for_admin_gates(self) -> None:
        """The ``message`` argument is additive — the six ``ADMIN_ROLES`` gates
        in ``catalog/routes.py`` pass only ``what`` and must read as before."""
        gate = RequireRole("super_admin", "admin", what="item tiers and prefixes")
        with pytest.raises(AuthorizationError) as exc:
            await gate(_User(role="operator"))
        assert exc.value.message == "Only an admin can manage item tiers and prefixes"


# ── Where the gate is mounted ─────────────────────────────────────────


class TestReturnDoorsAreGated:
    @pytest.mark.parametrize("path", sorted(GATED_ROUTES))
    def test_route_carries_a_super_admin_gate(self, path: str) -> None:
        route = _kit_post_routes().get(path)
        assert route is not None, f"{path} is not mounted"
        gates = _role_gates(route)
        assert gates, f"{path} has no RequireRole gate — CTL-001 regression"
        assert any(g.roles == frozenset({SUPER_ADMIN_ROLE}) for g in gates), (
            f"{path} has a role gate, but not a super-admin-only one: "
            f"{[sorted(g.roles) for g in gates]}"
        )

    @pytest.mark.parametrize("path", sorted(GATED_ROUTES))
    def test_the_gate_runs_before_the_handler(self, path: str) -> None:
        """A route-level dependency, not an in-handler check.

        Close-out and cancel consume a single-use reauth ticket. Refusing
        inside the handler would spend the operator's signature on the 403 and
        force a re-sign, so the ordering is a real requirement, not a style.
        """
        route = _kit_post_routes()[path]
        assert _role_gates(route), f"{path} must gate via Depends(), not in-body"

    @pytest.mark.parametrize("path,action", sorted(GATED_ROUTES.items()))
    def test_the_permission_check_survives_alongside_it(
        self, path: str, action: str
    ) -> None:
        """The role gate is added to the permission check, not swapped for it."""
        perms = _permissions(_kit_post_routes()[path])
        assert any(p.resource == "inventory" and p.action == action for p in perms), (
            f"{path} lost its inventory:{action} check"
        )


class TestProduceStaysOpen:
    @pytest.mark.parametrize("path,action", sorted(UNGATED_ROUTES.items()))
    def test_route_has_no_role_gate(self, path: str, action: str) -> None:
        """Producing and issuing move material OUT of inventory or consume it on
        the floor. CTL-001 is about material coming BACK, so gating these would
        stop the floor working without an admin present — the explicit
        instruction on 2026-08-27 was that produce stays open."""
        route = _kit_post_routes().get(path)
        assert route is not None, f"{path} is not mounted"
        assert not _role_gates(route), (
            f"{path} gained a role gate — produce/issue must stay open to any "
            f"role holding inventory:{action}"
        )


class TestNoUngatedReturnDoor:
    """The door inventory — the test that catches a *new* return route.

    Anything under ``/kits`` whose path says it returns or cancels must be
    gated. A future "return everything" or "undo issue" endpoint fails here the
    moment it is mounted, instead of shipping open.
    """

    RETURN_WORDS = ("return", "cancel", "close-out", "backflush", "back-flush")

    def test_every_return_shaped_route_is_gated(self) -> None:
        ungated = [
            path
            for path, route in _kit_post_routes().items()
            if any(w in path.lower() for w in self.RETURN_WORDS)
            and not _role_gates(route)
        ]
        assert ungated == [], (
            f"these routes credit material back to inventory but are not "
            f"super-admin-gated: {ungated}"
        )

    def test_the_three_known_doors_are_all_of_them(self) -> None:
        """If this fails, a return-shaped route was added — decide whether it is
        a CTL-001 door and add it to ``GATED_ROUTES`` (or rename it if it is
        not)."""
        found = {
            path
            for path in _kit_post_routes()
            if any(w in path.lower() for w in self.RETURN_WORDS)
        }
        assert found == set(GATED_ROUTES)
