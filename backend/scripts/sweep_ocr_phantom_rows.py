import asyncio, os, sys
sys.path.insert(0, '/app/backend')
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
load_dotenv('/app/backend/.env')

from statements import _looks_like_summary_sidebar, _has_alpha_content


async def main():
    db = AsyncIOMotorClient(os.environ['MONGO_URL'])[os.environ['DB_NAME']]
    total_flagged = 0
    per_company = {}
    async for t in db.transactions.find({'source': 'veryfi'}):
        desc = str(t.get('description') or t.get('merchant') or '').strip()
        if _looks_like_summary_sidebar(desc) or not _has_alpha_content(desc):
            cid = t.get('company_id')
            per_company[cid] = per_company.get(cid, 0) + 1
            total_flagged += 1
            await db.transactions.update_one(
                {'id': t['id']},
                {'$set': {
                    'needs_review': True,
                    'ai_reasoning': ('OCR sanity guard: description looks like '
                                     'a summary sidebar or numeric-only balance '
                                     'column, not a real transaction. Verify '
                                     'against the PDF.'),
                    'ocr_flagged_at': '2026-08-24',
                }},
            )
    print(f'Historical Veryfi phantom rows flagged for review: {total_flagged}')
    for cid, n in list(per_company.items())[:10]:
        c = await db.companies.find_one({'id': cid}, {'name': 1})
        name = (c or {}).get('name', cid)
        print(f'  {name}: {n}')


asyncio.run(main())
