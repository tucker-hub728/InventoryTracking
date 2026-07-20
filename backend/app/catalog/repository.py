"""Persistence helpers for the catalogue module (tiers + BOM)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.models.inventory import BomLine, Item, ItemPrefix, ItemTier

# ── Tiers ─────────────────────────────────────────────────────────


async def list_tiers(session: AsyncSession) -> list[ItemTier]:
    stmt = (
        select(ItemTier)
        .where(ItemTier.deleted_at.is_(None))
        .order_by(ItemTier.is_seeded.desc(), func.lower(ItemTier.name))
    )
    return list((await session.execute(stmt)).scalars().all())


async def get_tier(
    session: AsyncSession, tier_id: uuid.UUID
) -> ItemTier | None:
    stmt = select(ItemTier).where(
        ItemTier.id == tier_id, ItemTier.deleted_at.is_(None)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_tier_by_name(
    session: AsyncSession, name: str
) -> ItemTier | None:
    stmt = select(ItemTier).where(
        func.lower(ItemTier.name) == name.lower(),
        ItemTier.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def tier_item_counts(
    session: AsyncSession, tier_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """Live (non-deleted) item count per tier."""
    if not tier_ids:
        return {}
    # Tier lives on the prefix now — count items via their prefix's tier.
    stmt = (
        select(ItemPrefix.tier_id, func.count(Item.id))
        .join(ItemPrefix, ItemPrefix.id == Item.prefix_id)
        .where(ItemPrefix.tier_id.in_(tier_ids), Item.deleted_at.is_(None))
        .group_by(ItemPrefix.tier_id)
    )
    return {cid: int(n) for cid, n in (await session.execute(stmt)).all()}


async def create_tier(
    session: AsyncSession,
    *,
    name: str,
    tier_type: str,
    tone: str,
    created_by_user_id: uuid.UUID,
) -> ItemTier:
    cat = ItemTier(
        name=name,
        type=tier_type,
        tone=tone,
        is_seeded=False,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    session.add(cat)
    await session.flush()
    refreshed = await get_tier(session, cat.id)
    assert refreshed is not None
    return refreshed


async def apply_tier_patch(
    session: AsyncSession,
    *,
    tier: ItemTier,
    patch: dict[str, object],
    updated_by_user_id: uuid.UUID,
) -> ItemTier:
    for col, value in patch.items():
        setattr(tier, col, value)
    tier.updated_by_user_id = updated_by_user_id
    await session.flush()
    # Re-read so the server-bumped ``updated_at`` is populated (avoids a
    # lazy-load MissingGreenlet in the sync serializer).
    refreshed = await get_tier(session, tier.id)
    assert refreshed is not None
    return refreshed


async def soft_delete_tier(
    session: AsyncSession,
    *,
    tier: ItemTier,
    deleted_by_user_id: uuid.UUID,
) -> ItemTier:
    tier.deleted_at = datetime.now(UTC)
    tier.updated_by_user_id = deleted_by_user_id
    await session.flush()
    # Reload server-side-bumped ``updated_at`` (touch trigger) so the sync
    # serializer doesn't lazy-load an expired attribute (MissingGreenlet).
    await session.refresh(tier)
    return tier


def tier_to_audit_snapshot(tier: ItemTier) -> dict[str, object | None]:
    return {
        "name": tier.name,
        "type": tier.type,
        "tone": tier.tone,
        "is_seeded": tier.is_seeded,
        "deleted_at": (
            tier.deleted_at.isoformat() if tier.deleted_at else None
        ),
    }


# ── Prefixes ───────────────────────────────────────────────────────────


async def list_prefixes(
    session: AsyncSession, tier_id: uuid.UUID
) -> list[ItemPrefix]:
    """A tier's live prefixes, seeded-first then A-Z by code."""
    stmt = (
        select(ItemPrefix)
        .where(
            ItemPrefix.tier_id == tier_id,
            ItemPrefix.deleted_at.is_(None),
        )
        .order_by(ItemPrefix.is_seeded.desc(), func.lower(ItemPrefix.code))
    )
    return list((await session.execute(stmt)).scalars().all())


async def get_prefix(
    session: AsyncSession, prefix_id: uuid.UUID
) -> ItemPrefix | None:
    stmt = select(ItemPrefix).where(
        ItemPrefix.id == prefix_id, ItemPrefix.deleted_at.is_(None)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_prefix_by_code(
    session: AsyncSession, code: str
) -> ItemPrefix | None:
    """Live prefix with this code (case-insensitive), across all tiers."""
    stmt = select(ItemPrefix).where(
        func.lower(ItemPrefix.code) == code.lower(),
        ItemPrefix.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def prefix_item_counts(
    session: AsyncSession, prefix_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """Live (non-deleted) item count per prefix."""
    if not prefix_ids:
        return {}
    stmt = (
        select(Item.prefix_id, func.count())
        .where(Item.prefix_id.in_(prefix_ids), Item.deleted_at.is_(None))
        .group_by(Item.prefix_id)
    )
    return {pid: int(n) for pid, n in (await session.execute(stmt)).all()}


async def clear_tier_default_prefix(
    session: AsyncSession, *, tier_id: uuid.UUID, except_prefix_id: uuid.UUID | None
) -> None:
    """Unset ``is_default`` on the tier's other live prefixes.

    Called before promoting a new default so the partial-unique index
    (``uq_item_prefixes_default_per_tier``) never sees two defaults at once.
    """
    stmt = select(ItemPrefix).where(
        ItemPrefix.tier_id == tier_id,
        ItemPrefix.is_default.is_(True),
        ItemPrefix.deleted_at.is_(None),
    )
    if except_prefix_id is not None:
        stmt = stmt.where(ItemPrefix.id != except_prefix_id)
    for row in (await session.execute(stmt)).scalars().all():
        row.is_default = False
    await session.flush()


async def create_prefix(
    session: AsyncSession,
    *,
    tier_id: uuid.UUID,
    code: str,
    label: str | None,
    is_default: bool,
    created_by_user_id: uuid.UUID,
) -> ItemPrefix:
    prefix = ItemPrefix(
        tier_id=tier_id,
        code=code,
        label=label,
        is_default=is_default,
        is_seeded=False,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    session.add(prefix)
    await session.flush()
    refreshed = await get_prefix(session, prefix.id)
    assert refreshed is not None
    return refreshed


async def apply_prefix_patch(
    session: AsyncSession,
    *,
    prefix: ItemPrefix,
    patch: dict[str, object],
    updated_by_user_id: uuid.UUID,
) -> ItemPrefix:
    for col, value in patch.items():
        setattr(prefix, col, value)
    prefix.updated_by_user_id = updated_by_user_id
    await session.flush()
    refreshed = await get_prefix(session, prefix.id)
    assert refreshed is not None
    return refreshed


async def soft_delete_prefix(
    session: AsyncSession,
    *,
    prefix: ItemPrefix,
    deleted_by_user_id: uuid.UUID,
) -> ItemPrefix:
    prefix.deleted_at = datetime.now(UTC)
    # A deleted prefix must not keep the tier's single default slot.
    prefix.is_default = False
    prefix.updated_by_user_id = deleted_by_user_id
    await session.flush()
    await session.refresh(prefix)
    return prefix


def prefix_to_audit_snapshot(prefix: ItemPrefix) -> dict[str, object | None]:
    return {
        "tier_id": str(prefix.tier_id),
        "code": prefix.code,
        "label": prefix.label,
        "is_default": prefix.is_default,
        "is_seeded": prefix.is_seeded,
        "deleted_at": (
            prefix.deleted_at.isoformat() if prefix.deleted_at else None
        ),
    }


# ── BOM lines ──────────────────────────────────────────────────────────


async def list_bom_lines(
    session: AsyncSession, parent_item_id: uuid.UUID
) -> list[BomLine]:
    """Direct BOM lines of a parent (child item + its stock/tier eager)."""
    stmt = (
        select(BomLine)
        .where(
            BomLine.parent_item_id == parent_item_id,
            BomLine.deleted_at.is_(None),
        )
        .order_by(BomLine.created_at)
    )
    return list((await session.execute(stmt)).scalars().unique().all())


async def get_bom_line(
    session: AsyncSession, line_id: uuid.UUID
) -> BomLine | None:
    stmt = select(BomLine).where(
        BomLine.id == line_id, BomLine.deleted_at.is_(None)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_bom_line_by_pair(
    session: AsyncSession, parent_item_id: uuid.UUID, child_item_id: uuid.UUID
) -> BomLine | None:
    stmt = select(BomLine).where(
        BomLine.parent_item_id == parent_item_id,
        BomLine.child_item_id == child_item_id,
        BomLine.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_bom_line(
    session: AsyncSession,
    *,
    parent_item_id: uuid.UUID,
    child_item_id: uuid.UUID,
    qty_per_unit: Decimal,
    created_by_user_id: uuid.UUID,
) -> BomLine:
    line = BomLine(
        parent_item_id=parent_item_id,
        child_item_id=child_item_id,
        qty_per_unit=qty_per_unit,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    session.add(line)
    await session.flush()
    refreshed = await get_bom_line(session, line.id)
    assert refreshed is not None
    return refreshed


async def apply_bom_line_patch(
    session: AsyncSession,
    *,
    line: BomLine,
    patch: dict[str, object],
    updated_by_user_id: uuid.UUID,
) -> BomLine:
    for col, value in patch.items():
        setattr(line, col, value)
    line.updated_by_user_id = updated_by_user_id
    await session.flush()
    refreshed = await get_bom_line(session, line.id)
    assert refreshed is not None
    return refreshed


async def soft_delete_bom_line(
    session: AsyncSession,
    *,
    line: BomLine,
    deleted_by_user_id: uuid.UUID,
) -> BomLine:
    line.deleted_at = datetime.now(UTC)
    line.updated_by_user_id = deleted_by_user_id
    await session.flush()
    # The UPDATE bumps ``updated_at`` server-side (touch trigger / onupdate),
    # which SQLAlchemy expires. Refresh now — inside the async context — so the
    # (sync) serializer doesn't lazy-load it and hit MissingGreenlet. Refresh
    # also re-loads the joined child item/stock/tier.
    await session.refresh(line)
    return line


def bom_line_to_audit_snapshot(line: BomLine) -> dict[str, object | None]:
    return {
        "parent_item_id": str(line.parent_item_id),
        "child_item_id": str(line.child_item_id),
        "qty_per_unit": str(line.qty_per_unit),
        "deleted_at": line.deleted_at.isoformat() if line.deleted_at else None,
    }


async def where_used(
    session: AsyncSession, child_item_id: uuid.UUID
) -> list[BomLine]:
    """BOM lines where the queried item is the child — i.e. its parents.

    ``parent_item`` (and its tier) eager-load for serialisation.
    """
    stmt = (
        select(BomLine)
        .where(
            BomLine.child_item_id == child_item_id,
            BomLine.deleted_at.is_(None),
        )
        .options(
            joinedload(BomLine.parent_item)
            .joinedload(Item.prefix)
            .joinedload(ItemPrefix.tier)
        )
        .order_by(BomLine.created_at)
    )
    return list((await session.execute(stmt)).scalars().unique().all())


async def would_create_cycle(
    session: AsyncSession,
    *,
    parent_item_id: uuid.UUID,
    child_item_id: uuid.UUID,
) -> bool:
    """Would adding ``child`` under ``parent`` create a cycle (A→B→A)?

    True if they're the same item, or the parent is reachable by walking down
    from the candidate child through existing BOM links.
    """
    if parent_item_id == child_item_id:
        return True
    seen: set[uuid.UUID] = set()
    frontier: list[uuid.UUID] = [child_item_id]
    while frontier:
        ids = [f for f in frontier if f not in seen]
        if not ids:
            break
        seen.update(ids)
        rows = list(
            (
                await session.execute(
                    select(BomLine.child_item_id).where(
                        BomLine.parent_item_id.in_(ids),
                        BomLine.deleted_at.is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
        if parent_item_id in rows:
            return True
        frontier = rows
    return False
