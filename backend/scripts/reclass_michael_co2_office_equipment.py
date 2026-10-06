"""Fix-up: repoint Michael Co 2's 3 Office Equipment bills from Fuel (6350 taken) to new 6360 Office Equipment."""
from __future__ import annotations
import asyncio
import sys
import uuid
sys.path.insert(0, "/app/backend")
from db import db, now_iso  # noqa: E402

CID = "aae4ab61-5b14-4529-a38c-fef8b747fdec"
FUEL_ID = "2c45b466-d265-4fac-a331-8d1066dae78d"
BILLS = ["BILL-2004", "BILL-2005", "BILL-2014"]


async def main() -> None:
    now = now_iso()
    tgt = {"id": str(uuid.uuid4()), "company_id": CID, "code": "6360", "name": "Office Equipment",
           "type": "expense", "subtype": "operating_expense", "detail_type": "operating_expense",
           "active": True, "balance": 0.0, "created_at": now, "updated_at": now}
    await db.accounts.insert_one(tgt)
    r1 = await db.journal_entries.update_many(
        {"company_id": CID, "lines": {"$elemMatch": {"account_id": FUEL_ID, "account_name": "Office Equipment"}}},
        {"$set": {"lines.$[el].account_id": tgt["id"], "updated_at": now}},
        array_filters=[{"el.account_id": FUEL_ID, "el.account_name": "Office Equipment"}])
    r2 = await db.bills.update_many(
        {"company_id": CID, "number": {"$in": BILLS}, "line_items.account_id": FUEL_ID},
        {"$set": {"line_items.$[el].account_id": tgt["id"], "updated_at": now}},
        array_filters=[{"el.account_id": FUEL_ID}])
    print("target", tgt["id"], "JEs", r1.modified_count, "bills", r2.modified_count)


if __name__ == "__main__":
    asyncio.run(main())
