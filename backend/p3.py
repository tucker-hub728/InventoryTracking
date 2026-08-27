import asyncio, uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from app.core.config import get_settings
from app.models.identity import User
from app.models.inventory import ItemStock, StockMovement
from app.consumables.routes import create_restock_request, list_restock_requests, cancel_restock_request
from app.consumables.schemas import RestockRequestCreate
from app.consumables import repository as cons_repo

ITEM = uuid.UUID("f6dd6f8b-20f4-4f57-bc80-9b8619afcd00")
KANBAN = uuid.UUID("2208f019-9792-4bb0-8ba5-7e24dc52a028")

async def main():
    eng = create_async_engine(str(get_settings().database_url), poolclass=NullPool)
    S = async_sessionmaker(eng, expire_on_commit=False)
    async with S() as db:
        user = (await db.execute(select(User).where(User.role=="super_admin").limit(1))).scalars().first()
        before = (await db.execute(select(ItemStock.qty_on_hand, ItemStock.qty_available).where(ItemStock.item_id==ITEM))).one()
        print("on_hand/available BEFORE issue:", tuple(int(x) for x in before))

        mv = await cons_repo.create_issue_movement(
            db, item_id=ITEM, lot_id=(await db.execute(select(StockMovement.lot_id).where(StockMovement.item_id==ITEM, StockMovement.lot_id.isnot(None)).limit(1))).scalar_one(),
            from_location_node_id=(await db.execute(select(StockMovement.to_location_node_id).where(StockMovement.item_id==ITEM, StockMovement.movement_type=="receipt").limit(1))).scalar_one(),
            kanban_node_id=KANBAN, qty=10, performed_by_user_id=user.id,
        )
        rows = (await db.execute(select(StockMovement.movement_type).where(StockMovement.item_id==ITEM))).scalars().all()
        print("issue wrote:", mv.movement_type, "delta", mv.qty_delta, "| new-type rows now:", sum(1 for r in rows if r=="consumable_stock_in"))
        after = (await db.execute(select(ItemStock.qty_on_hand, ItemStock.qty_available).where(ItemStock.item_id==ITEM))).one()
        print("on_hand/available AFTER issuing 10:", tuple(int(x) for x in after))
        await db.rollback()

    async with S() as db:
        user = (await db.execute(select(User).where(User.role=="super_admin").limit(1))).scalars().first()
        r = await create_restock_request(db, user, RestockRequestCreate(kanban_node_id=str(KANBAN), item_id=str(ITEM), requested_qty=25, note="probe"))
        print("REQUEST OK:", r.item_number, r.state, "issued_since:", r.issued_since_qty)
        lst = await list_restock_requests(db, kanban_node_id=str(KANBAN), state="open")
        print("LIST OK:", lst.total)
        c = await cancel_restock_request(db, user, uuid.UUID(r.id))
        print("CANCEL OK:", c.state, "consumed_qty:", c.consumed_qty)
    await eng.dispose()

asyncio.run(main())
