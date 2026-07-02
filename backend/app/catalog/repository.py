"""Persistence helpers for the catalogue module (categories + BOM)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.models.inventory import BomLine, Item, ItemCategory

# ── Categories ─────────────────────────────────────────────────────────


async def list_categories(session: AsyncSession) -> list[ItemCategory]:
    stmt = (
        select(ItemCategory)
        .where(ItemCategory.deleted_at.is_(None))
        .order_by(ItemCategory.is_seeded.desc(), func.lower(ItemCategory.name))
    )
    return list((await session.execute(stmt)).scalars().all())


async def get_category(
    session: AsyncSession, category_id: uuid.UUID
) -> ItemCategory | None:
    stmt = select(ItemCategory).where(
        ItemCategory.id == category_id, ItemCategory.deleted_at.is_(None)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_category_by_name(
    session: AsyncSession, name: str
) -> ItemCategory | None:
    stmt = select(ItemCategory).where(
        func.lower(ItemCategory.name) == name.lower(),
        ItemCategory.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def category_item_counts(
    session: AsyncSession, category_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """Live (non-deleted) item count per category."""
    if not category_ids:
        return {}
    stmt = (
        select(Item.category_id, func.count())
        .where(Item.category_id.in_(category_ids), Item.deleted_at.is_(None))
        .group_by(Item.category_id)
    )
    return {cid: int(n) for cid, n in (await session.execute(stmt)).all()}


async def create_category(
    session: AsyncSession,
    *,
    name: str,
    kind: str,
    tone: str,
    created_by_user_id: uuid.UUID,
) -> ItemCategory:
    cat = ItemCategory(
        name=name,
        kind=kind,
        tone=tone,
        is_seeded=False,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    session.add(cat)
    await session.flush()
    refreshed = await get_category(session, cat.id)
    assert refreshed is not None
    return refreshed


async def apply_category_patch(
    session: AsyncSession,
    *,
    category: ItemCategory,
    patch: dict[str, object],
    updated_by_user_id: uuid.UUID,
) -> ItemCategory:
    for col, value in patch.items():
        setattr(category, col, value)
    category.updated_by_user_id = updated_by_user_id
    await session.flush()
    # Re-read so the server-bumped ``updated_at`` is populated (avoids a
    # lazy-load MissingGreenlet in the sync serializer).
    refreshed = await get_category(session, category.id)
    assert refreshed is not None
    return refreshed


async def soft_delete_category(
    session: AsyncSession,
    *,
    category: ItemCategory,
    deleted_by_user_id: uuid.UUID,
) -> ItemCategory:
    category.deleted_at = datetime.now(UTC)
    category.updated_by_user_id = deleted_by_user_id
    await session.flush()
    # Reload server-side-bumped ``updated_at`` (touch trigger) so the sync
    # serializer doesn't lazy-load an expired attribute (MissingGreenlet).
    await session.refresh(category)
    return category


def category_to_audit_snapshot(category: ItemCategory) -> dict[str, object | None]:
    return {
        "name": category.name,
        "kind": category.kind,
        "tone": category.tone,
        "is_seeded": category.is_seeded,
        "deleted_at": (
            category.deleted_at.isoformat() if category.deleted_at else None
        ),
    }


# ── BOM lines ──────────────────────────────────────────────────────────


async def list_bom_lines(
    session: AsyncSession, parent_item_id: uuid.UUID
) -> list[BomLine]:
    """Direct BOM lines of a parent (child item + its stock/category eager)."""
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
    qty_per_run: Decimal,
    created_by_user_id: uuid.UUID,
) -> BomLine:
    line = BomLine(
        parent_item_id=parent_item_id,
        child_item_id=child_item_id,
        qty_per_run=qty_per_run,
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
    # also re-loads the joined child item/stock/category.
    await session.refresh(line)
    return line


def bom_line_to_audit_snapshot(line: BomLine) -> dict[str, object | None]:
    return {
        "parent_item_id": str(line.parent_item_id),
        "child_item_id": str(line.child_item_id),
        "qty_per_run": str(line.qty_per_run),
        "deleted_at": line.deleted_at.isoformat() if line.deleted_at else None,
    }


async def where_used(
    session: AsyncSession, child_item_id: uuid.UUID
) -> list[BomLine]:
    """BOM lines where the queried item is the child — i.e. its parents.

    ``parent_item`` (and its category) eager-load for serialisation.
    """
    stmt = (
        select(BomLine)
        .where(
            BomLine.child_item_id == child_item_id,
            BomLine.deleted_at.is_(None),
        )
        .options(joinedload(BomLine.parent_item).joinedload(Item.category))
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
