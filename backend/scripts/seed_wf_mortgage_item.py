"""CLI wrapper: re-mint the Wells Fargo $2,145.67 mortgage split check-in
item for Michael Co 2, LLC. Same logic as the pro "Reset demo" button
(POST /api/cockpit/demo/reset-wf-mortgage/{cid}).

    cd /app/backend && PYTHONPATH=/app/backend python scripts/seed_wf_mortgage_item.py [company_id]
"""
import asyncio, sys
from dotenv import load_dotenv
load_dotenv("/app/backend/.env")

from demo_reset import reset_wf_mortgage_item  # noqa: E402

CID = sys.argv[1] if len(sys.argv) > 1 else "aae4ab61-5b14-4529-a38c-fef8b747fdec"

if __name__ == "__main__":
    print(asyncio.run(reset_wf_mortgage_item(CID)))
