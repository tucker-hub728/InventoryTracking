"""A suppliers-only item edit must not 500 (Sandbox, 2026-09-18).

Editing only the Suppliers on an item returned "An unexpected error occurred."
— twelve times across four CR items on the Sandbox. The log named it:
``MissingGreenlet`` at ``_item_to_read`` reading ``item.updated_at``.

The suppliers-only branch of ``update_item`` bumps ``updated_by_user_id`` and
flushes. That UPDATE fires ``onupdate=func.now()``, which EXPIRES
``updated_at``; the response then read it, which is a hidden lazy load, and a
lazy load in an async session raises instead of querying.

Why it hid: the UPDATE only happens when the editor is NOT already the item's
last updater — otherwise the assignment is a no-op and nothing expires. Every
local test ran as the same user that created the item. The Sandbox's CR items
were all stamped with the dev super admin by the prod → dev refresh, so anyone
else editing them hit it every time. Hence the two users below.

Runs the real route against the real database inside a transaction that is
rolled back: the route commits, so the session joins an outer transaction with
``create_savepoint`` and that commit only releases a savepoint.
"""

from __future__ import annotations

import uuid

import pytest_asyncio
from app.core.config import get_settings
from app.inventory.routes import update_item
from app.inventory.schemas import ItemUpdate
from app.models.identity import User
from app.models.inventory import Item, ItemPrefix, ItemTier, Supplier
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool


def _user(tag: str) -> User:
    uid = uuid.uuid4().hex[:12]
    return User(
        cognito_sub=f"supedit-{tag}-{uid}",
        email=f"supedit-{tag}-{uid}@example.invalid",
        full_name=f"Supplier-edit {tag}",
        initials="SE",
        role="super_admin",
    )


@pytest_asyncio.fixture
async def session():
    """A session whose commits are savepoints inside a rolled-back transaction."""
    engine = create_async_engine(str(get_settings().database_url), poolclass=NullPool)
    async with engine.connect() as conn:
        outer = await conn.begin()
        s = AsyncSession(
            bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False
        )
        try:
            yield s
        finally:
            await s.close()
            await outer.rollback()
    await engine.dispose()


@pytest_asyncio.fixture
async def item_by_someone_else(session: AsyncSession):
    """``(item, supplier, editor)`` — the item was last updated by a DIFFERENT
    user than ``editor``, which is the precondition for the bug."""
    creator, editor = _user("creator"), _user("editor")
    session.add_all([creator, editor])
    await session.flush()

    prefix_id = (await session.execute(select(ItemPrefix.id).limit(1))).scalar_one_or_none()
    if prefix_id is None:
        # The test database may be empty — seed rather than skip, or the guard
        # guards nothing.
        tier = ItemTier(
            name=f"Supplier-edit tier {uuid.uuid4().hex[:6]}",
            type="raw_material",
            tone="neutral",
            created_by_user_id=creator.id,
            updated_by_user_id=creator.id,
        )
        session.add(tier)
        await session.flush()
        prefix = ItemPrefix(
            tier_id=tier.id,
            code=f"S{uuid.uuid4().hex[:4].upper()}",
            label="Supplier-edit fixture",
            created_by_user_id=creator.id,
            updated_by_user_id=creator.id,
        )
        session.add(prefix)
        await session.flush()
        prefix_id = prefix.id

    item = Item(
        prefix_id=prefix_id,
        sku_suffix=f"SE{uuid.uuid4().hex[:8]}",
        description="Supplier-edit fixture",
        uom="Each",
        created_by_user_id=creator.id,
        updated_by_user_id=creator.id,
    )
    supplier = Supplier(name=f"Supplier-edit {uuid.uuid4().hex[:8]}")
    session.add_all([item, supplier])
    await session.flush()
    return item, supplier, editor


async def test_suppliers_only_edit_by_another_user_succeeds(
    session: AsyncSession, item_by_someone_else
) -> None:
    item, supplier, editor = item_by_someone_else

    result = await update_item(
        db=session,
        current=editor,
        item_id=item.id,
        payload=ItemUpdate(supplier_ids=[str(supplier.id)]),
    )

    assert [s.supplier_id for s in result.suppliers] == [str(supplier.id)]
    assert result.updated_by_user_id == str(editor.id)
    # The response carries the timestamp the flush just wrote — the exact read
    # that used to raise.
    assert result.updated_at is not None


async def test_clearing_suppliers_by_another_user_succeeds(
    session: AsyncSession, item_by_someone_else
) -> None:
    """``[]`` takes the same suppliers-only branch."""
    item, _supplier, editor = item_by_someone_else

    result = await update_item(
        db=session,
        current=editor,
        item_id=item.id,
        payload=ItemUpdate(supplier_ids=[]),
    )

    assert result.suppliers == []
