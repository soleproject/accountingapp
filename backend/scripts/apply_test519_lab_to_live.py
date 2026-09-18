"""One-off: run lab v3 and commit the results to Test 519 LLC's live books.

Calls `lab_pipeline.commit.run_lab_and_commit(company_id)` which does:
  Phase 1 → Phase 2 (LLM) → Phase 3 (LLM) →
  promote pending accounts → commit categorization to db.transactions.

Prints before/after counts so we can see the diff.
"""
import asyncio
import os
import sys
import time
from dotenv import load_dotenv
load_dotenv('/app/backend/.env')
sys.path.insert(0, '/app/backend')

from motor.motor_asyncio import AsyncIOMotorClient
from lab_pipeline.commit import run_lab_and_commit

CID = 'eae0bd47-0545-4f7c-9175-d838f8d1637b'


async def snapshot(db, label: str) -> None:
    print(f'\n--- {label} ---')
    for name, q in [
        ('total_transactions',       {'company_id': CID}),
        ('needs_review',             {'company_id': CID, 'needs_review': True}),
        ('ai_source lab_v3',         {'company_id': CID, 'ai_source': 'lab_v3'}),
        ('lab_v3 & needs_review',    {'company_id': CID, 'ai_source': 'lab_v3', 'needs_review': True}),
        ('flagged_for_accountant',   {'company_id': CID, 'flagged_for_accountant': True}),
    ]:
        n = await db.transactions.count_documents(q)
        print(f'  {name:26s} {n}')


async def main() -> None:
    cli = AsyncIOMotorClient(os.environ['MONGO_URL'])
    db = cli[os.environ['DB_NAME']]
    await snapshot(db, 'BEFORE')
    t0 = time.time()
    print('\nCalling run_lab_and_commit ...')
    result = await run_lab_and_commit(CID)
    print(f'\nrun_lab_and_commit returned in {time.time()-t0:.1f}s:')
    print(result)
    await snapshot(db, 'AFTER')


if __name__ == '__main__':
    asyncio.run(main())
