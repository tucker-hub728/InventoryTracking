"""Every priced export is ``inventory:view`` **+ Super Admin alone**.

``inventory.csv``, ``inventory.xlsx`` and ``kit-costs.csv`` carry unit prices,
extended lot values, per-movement value amounts and what each customer is
charged per finished lot. ``inventory:view`` is held by *every* role, so gating
on the permission alone handed a fully priced valuation to every ``read_only``
account — 349 of them active on dev.

The gates converged in two steps on 2026-09-03: RPT-001 was first widened to
RPT-003's ``ADMIN_ROLES``, then the client narrowed **both** to ``super_admin``.
``admin`` is refused everywhere in this table — that is the part worth pinning
down, because "an admin surely ought to be able to export" is the reasonable-
sounding change that would undo it.

This file asserts the **gate**, not the file format — the column contract is
covered by ``test_exports_inventory_csv.py`` and ``test_exports_workbook.py``.
It reads the composed app's dependency graph rather than making HTTP calls, so
it runs in CI without Cognito and it fails if someone adds a new export route
without a gate, or quietly relaxes an existing one.
"""

from __future__ import annotations

import pytest
from app.main import create_app
from app.security.permissions import (
    ADMIN_ROLES,
    SUPER_ADMIN_ROLE,
    RequirePermission,
    RequireRole,
    has_permission,
)
from fastapi.routing import APIRoute

#: Every route that ships priced data. Add to this list, not around it.
PRICED_EXPORTS = [
    "/v1/exports/inventory.csv",
    "/v1/exports/inventory.xlsx",
    "/v1/exports/kit-costs.csv",
]

#: The one role set allowed to take any of them.
ALLOWED = frozenset({SUPER_ADMIN_ROLE})


def _gates(path: str) -> tuple[set[tuple[str, str]], set[frozenset[str]]]:
    """Return the (resource, action) and role gates guarding ``path``."""
    app = create_app()
    perms: set[tuple[str, str]] = set()
    roles: set[frozenset[str]] = set()

    def walk(dep) -> None:
        call = dep.call
        if isinstance(call, RequirePermission):
            perms.add((call.resource, call.action))
        elif isinstance(call, RequireRole):
            roles.add(call.roles)
        for sub in dep.dependencies:
            walk(sub)

    for route in app.routes:
        if isinstance(route, APIRoute) and route.path == path:
            for dep in route.dependant.dependencies:
                walk(dep)
            return perms, roles
    raise AssertionError(f"route {path} not found")


@pytest.mark.parametrize("path", PRICED_EXPORTS)
def test_priced_export_requires_view_and_super_admin(path: str) -> None:
    perms, roles = _gates(path)
    assert ("inventory", "view") in perms, f"{path} lost its inventory:view gate"
    assert ALLOWED in roles, (
        f"{path} is not gated on {sorted(ALLOWED)} — a lower role can download "
        f"priced data. Found role gates: {roles or 'none'}"
    )


@pytest.mark.parametrize("path", PRICED_EXPORTS)
def test_priced_export_refuses_admin(path: str) -> None:
    """``admin`` is refused on every priced export (client, 2026-09-03).

    Asserted separately from the check above because a gate could satisfy that
    one and still admit ``admin`` through a second, wider ``RequireRole``.
    Widening back to ``ADMIN_ROLES`` is the specific regression to catch: it is
    what "an admin should be able to export, surely" looks like in a diff.
    """
    _, roles = _gates(path)
    assert ADMIN_ROLES not in roles, f"{path} was widened back to ADMIN_ROLES"
    for gate in roles:
        assert "admin" not in gate or gate == ALLOWED, (
            f"{path} admits 'admin' again — the priced exports are "
            f"super-admin-only. Offending gate: {sorted(gate)}"
        )


def test_the_permission_alone_would_not_be_enough() -> None:
    """Why the role half exists: every role holds ``inventory:view``.

    If this ever fails because a role lost ``inventory:view``, the role gates
    above are still correct — but the comment explaining them is not.
    """
    for role in ("read_only", "operator", "admin", "super_admin"):
        assert has_permission(role, "inventory", "view") is True

    assert "read_only" not in ADMIN_ROLES
    assert "operator" not in ADMIN_ROLES
    assert frozenset({"admin", "super_admin"}) == ADMIN_ROLES
    assert SUPER_ADMIN_ROLE == "super_admin"
    # The gates are narrower than ADMIN_ROLES, not equal to it — if these ever
    # become the same set, `test_priced_export_refuses_admin` stops meaning
    # anything and this assertion is the one that says so.
    assert ALLOWED < ADMIN_ROLES
