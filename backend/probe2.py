import asyncio, uuid
from decimal import Decimal
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from app.core.config import get_settings
from app.models.identity import User
from app.models.inventory import ItemStock
from app.consumables import repository as cons_repo
from app.locations import repository as loc_repo

ITEM = uuid.UUID("f6dd6f8b-20f4-4f57-bc80-9b8619afcd00")
KANBAN = uuid.UUID("2208f019-9792-4bb0-8ba5-7e24dc52a028")

async def stock(db):
    r = (await db.execute(select(ItemStock.qty_on_hand, ItemStock.qty_available).where(ItemStock.item_id == ITEM))).one()
    return int(r[0]), int(r[1])

async def main():
    eng = create_async_engine(str(get_settings().database_url), poolclass=NullPool)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    async with Session() as db:
        user = (await db.execute(select(User).where(User.role == "super_admin").limit(1))).scalars().first()
        print("on_hand/available BEFORE:", await stock(db))

        allocs = await cons_repo.kanban_allocations_for_item(db, kanban_node_id=KANBAN, item_id=ITEM)
        print("bin allocations:", [(str(a.lot_id)[:8], int(a.qty)) for a in allocs])
        if not allocs:
            print("nothing in the bin to consume"); return

        a = allocs[0]
        take = min(10, int(a.qty))
        mv = await cons_repo.create_consumption_movement(
            db, item_id=ITEM, lot_id=a.lot_id, kanban_node_id=KANBAN, qty=take,
            performed_by_user_id=user.id, reauth_evidence_id=None, notes="probe",
        )
        await loc_repo.reduce_allocation(db, allocation=a, qty=take)
        await db.flush()
        print(f"consumption movement OK: {mv.movement_type} delta={mv.qty_delta}")
        print(f"on_hand/available AFTER consuming {take}:", await stock(db))
        await db.rollback()
        print("rolled back — dev data untouched")
    await eng.dispose()

asyncio.run(main())
