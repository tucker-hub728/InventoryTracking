import asyncio, uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from app.core.config import get_settings
from app.models.identity import User
from app.consumables.routes import (
    create_restock_request, list_restock_requests, kanban_balance, cancel_restock_request,
)
from app.consumables.schemas import RestockRequestCreate

ITEM = "f6dd6f8b-20f4-4f57-bc80-9b8619afcd00"
KANBAN = "2208f019-9792-4bb0-8ba5-7e24dc52a028"

async def main():
    eng = create_async_engine(str(get_settings().database_url), poolclass=NullPool)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    async with Session() as db:
        user = (await db.execute(select(User).where(User.role == "super_admin").limit(1))).scalars().first()
        print("actor:", user.email)

        bal = await kanban_balance(db, KANBAN)
        print("BALANCE:", [(i.item_number, i.qty, i.open_request_id) for i in bal.items])

        created = await create_restock_request(
            db, user, RestockRequestCreate(kanban_node_id=KANBAN, item_id=ITEM, requested_qty=50, note="probe")
        )
        print("CREATE OK:", created.id, created.item_number, created.state, "on_hand:", created.on_hand_qty)

        listed = await list_restock_requests(db, kanban_node_id=KANBAN, state="open")
        print("LIST OK:", listed.total, [r.item_number for r in listed.items])

        # duplicate must be refused, not 500
        try:
            await create_restock_request(
                db, user, RestockRequestCreate(kanban_node_id=KANBAN, item_id=ITEM, requested_qty=5, note="dup")
            )
            print("DUPLICATE: NOT REFUSED  <-- BUG")
        except Exception as e:
            print("DUPLICATE refused:", type(e).__name__, getattr(e, "code", ""))

        cancelled = await cancel_restock_request(db, user, uuid.UUID(created.id))
        print("CANCEL OK:", cancelled.state, cancelled.closed_at is not None)
    await eng.dispose()

asyncio.run(main())
