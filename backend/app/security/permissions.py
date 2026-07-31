"""In-code permission matrix — the v1 bridge.

The v1 MVP doc (§3) commits to a single rule for permissions until the
full RBAC tables ship: **the matrix below is the source of truth, keyed
by ``users.role``.** When v2 lands the matrix becomes the fallback /
seed and the check flips to a DB read — but no v1 table changes shape.

Routes consume this via ``RequirePermission('inventory', 'create')``.
``super_admin`` short-circuits every check.
"""

from __future__ import annotations

from app.core.exceptions import AuthorizationError

# Resource → set of allowed actions, per role. Mirrors the v1 doc §3.
PERM_MATRIX: dict[str, dict[str, frozenset[str]]] = {
    "super_admin": {"*": frozenset({"*"})},
    "admin": {
        "inventory": frozenset({"view", "create", "edit", "delete", "sign"}),
        # Member management (inviting, editing, deleting) is super-admin-only.
        # Admins get read-only visibility into the directory and the pending
        # invitation list, but cannot mutate either.
        "users": frozenset({"view"}),
        "audit": frozenset({"view", "export"}),
    },
    "operator": {
        "inventory": frozenset({"view", "create", "edit", "sign"}),
        "audit": frozenset({"view"}),
    },
    "read_only": {
        "inventory": frozenset({"view"}),
        "audit": frozenset({"view"}),
    },
}


# Roles that count as "an admin role" in the requirements' language. Used where
# the permission matrix genuinely cannot answer the question: ``operator`` also
# holds ``inventory:create``/``sign``, so a matrix check can't tell an admin from
# an operator for write purposes — only the role can.
ADMIN_ROLES: frozenset[str] = frozenset({"super_admin", "admin"})


class RequireRole:
    """FastAPI dependency — gate a route on the DB role itself.

    Companion to :class:`RequirePermission`, for the cases the matrix can't
    express. Reference data that defines how the whole catalogue behaves — the
    item tiers and their prefixes (REQ-2026-07-15-ITM-001), LN2 structure
    (REQ-2026-07-15-LOC-003) — is admin-maintained, but ``operator`` shares the
    inventory write bucket, so those routes pair a permission check with this.

    Usage::

        dependencies=[
            Depends(RequirePermission("inventory", "sign")),
            Depends(RequireRole(*ADMIN_ROLES)),
        ]
    """

    def __init__(self, *roles: str, what: str = "this") -> None:
        self.roles = frozenset(roles)
        self.what = what

    async def __call__(self, db_user: CurrentDbUserDep) -> None:  # type: ignore[name-defined]
        if db_user.role not in self.roles:
            raise AuthorizationError(
                f"Only an admin can manage {self.what}",
                code="permission_denied",
                details={"required_roles": sorted(self.roles)},
            )


def has_permission(role: str, resource: str, action: str) -> bool:
    """Pure predicate — easy to unit-test, used inside dependencies."""
    bucket = PERM_MATRIX.get(role)
    if bucket is None:
        return False
    if bucket.get("*") == frozenset({"*"}):
        return True
    return action in bucket.get(resource, frozenset())


class RequirePermission:
    """FastAPI dependency factory. Usage::

        @router.post("/items", dependencies=[Depends(RequirePermission("inventory", "create"))])
        async def create_item(...): ...

    The local DB ``app.users`` row is the source for the role — Cognito's
    ``custom:role`` is only the *initial* seed (see
    ``app.auth.provisioning``). We re-resolve through the DB on every
    call so role changes take effect without re-issuing tokens.
    """

    def __init__(self, resource: str, action: str) -> None:
        self.resource = resource
        self.action = action

    async def __call__(self, db_user: CurrentDbUserDep) -> None:  # type: ignore[name-defined]
        # ``CurrentDbUserDep`` already authenticated + resolved the local
        # row. We just check the role's bucket against the requested
        # ``(resource, action)``. Role changes take effect immediately —
        # there's no token-side cache to invalidate.
        if not has_permission(db_user.role, self.resource, self.action):
            raise AuthorizationError(
                f"Role '{db_user.role}' cannot {self.action} {self.resource}",
                code="permission_denied",
                details={"resource": self.resource, "action": self.action},
            )


# Late binding to avoid a circular import — ``api.deps`` imports from
# ``auth`` which imports from ``security`` (transitively through models
# in the future). Resolving the annotation at module load via a string
# keeps the cycle broken without ``TYPE_CHECKING`` gymnastics.
def _bind_currentdbuser() -> None:
    from app.api.deps import CurrentDbUserDep

    RequirePermission.__call__.__annotations__["db_user"] = CurrentDbUserDep
    RequireRole.__call__.__annotations__["db_user"] = CurrentDbUserDep


_bind_currentdbuser()


# Convenience type alias for routes that need the DB user themselves
# (e.g. to stamp ``created_by_user_id``). Imported by routes via
# ``from app.api.deps import CurrentDbUserDep``.
__all__ = ["ADMIN_ROLES", "PERM_MATRIX", "RequirePermission", "RequireRole", "has_permission"]
