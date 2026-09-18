"""Phase 1 report — deterministic run against picked test companies.

Enables ``features.lab_pipeline_v3`` on the target company, runs
Steps 1-4, and prints a full coverage / stats report.

    python -m scripts.lab_phase1_report
"""
from __future__ import annotations
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, "/app/backend")

from db import db
from lab_pipeline.collections import ensure_indexes
from lab_pipeline.runner import run_phase1

log = logging.getLogger("axiom.lab.phase1_report")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

TEST_COMPANIES = ["Test 519 LLC"]


async def _enable_flag(cid: str) -> None:
    await db.companies.update_one(
        {"id": cid}, {"$set": {"features.lab_pipeline_v3": True}}
    )


async def _find_company(name: str) -> dict | None:
    return await db.companies.find_one({"name": name})


async def _live_transfer_stats(cid: str) -> dict:
    """Compare against live transfer_pair_id stamping."""
    live_pairs: dict[str, list[str]] = {}
    async for r in db.transactions.find(
        {"company_id": cid, "transfer_pair_id": {"$ne": None}},
        {"id": 1, "transfer_pair_id": 1},
    ):
        live_pairs.setdefault(r["transfer_pair_id"], []).append(r["id"])
    lab_pairs: dict[str, list[str]] = {}
    async for r in db.lab_transactions.find(
        {"company_id": cid, "movement_type": "internal_transfer"},
        {"txn_id": 1, "movement_pair_id": 1},
    ):
        lab_pairs.setdefault(r["movement_pair_id"], []).append(r["txn_id"])

    live_pair_sets = [set(v) for v in live_pairs.values()]
    lab_pair_sets  = [set(v) for v in lab_pairs.values()]
    both, live_only, lab_only = 0, 0, 0
    live_only_examples, lab_only_examples = [], []
    for s in live_pair_sets:
        if any(s == l for l in lab_pair_sets):
            both += 1
        else:
            live_only += 1
            if len(live_only_examples) < 5:
                live_only_examples.append(sorted(s))
    for s in lab_pair_sets:
        if not any(s == l for l in live_pair_sets):
            lab_only += 1
            if len(lab_only_examples) < 5:
                lab_only_examples.append(sorted(s))
    return {
        "live_pairs":         len(live_pair_sets),
        "lab_pairs":          len(lab_pair_sets),
        "pairs_found_by_both": both,
        "live_only_pairs":    live_only,
        "lab_only_pairs":     lab_only,
        "live_only_examples": live_only_examples,
        "lab_only_examples":  lab_only_examples,
    }


async def main():
    await ensure_indexes()
    for name in TEST_COMPANIES:
        c = await _find_company(name)
        if not c:
            log.warning("Company %s not found", name)
            continue
        cid = c["id"]
        await _enable_flag(cid)

        t0 = time.time()
        result = await run_phase1(cid)
        dur = round(time.time() - t0, 2)

        xfer = await _live_transfer_stats(cid)

        out = Path(f"/tmp/lab_phase1_{cid}.json")
        out.write_text(json.dumps({
            "company": {"id": cid, "name": name},
            "run":     result,
            "transfer_comparison": xfer,
        }, indent=2, default=str))

        # ---- printed summary ----
        step1 = result["step1"]
        step2 = result["step2"]
        step3 = result["step3"]
        step4 = result["step4"]
        print("\n" + "=" * 72)
        print(f"LAB PHASE 1 — {name}   ({cid})")
        print(f"  {result['date_range']['min']} → {result['date_range']['max']}   "
              f"scanned={result['scanned']}  duration={dur}s")
        print("=" * 72)
        print(f"\nStep 1 — Raw layer")
        print(f"  upserted lab_transactions: {step1['upserted']}")
        print(f"  detected overwritten fields (unrecoverable without Plaid re-call):")
        if step1["overwrite_counts"]:
            for k, v in step1["overwrite_counts"].items():
                print(f"    {k:<50}  {v:>5}")
        else:
            print("    (none)")

        print(f"\nStep 2 — Parse")
        print(f"  channels seen:")
        for k, v in sorted(step2["channels"].items(), key=lambda x: -x[1]):
            print(f"    {k:<20}  {v:>5}")
        print(f"  bank format tags:")
        for k, v in sorted(step2["formats"].items(), key=lambda x: -x[1]):
            print(f"    {k:<20}  {v:>5}")
        if step2["paypal_kinds"]:
            print(f"  PayPal BoA rows by kind:")
            for k, v in step2["paypal_kinds"].items():
                print(f"    {k:<24}  {v:>5}")

        print(f"\nStep 3 — Account context")
        print(f"  connected accounts: {step3['connected']}")
        print(f"  outside accounts detected:")
        for k, v in step3["outside"].items():
            print(f"    {k:<28}  hits={v}")
        print(f"  payment apps: {step3['payment_apps']}")
        print(f"  credit lines: {step3['credit_lines']}")

        print(f"\nStep 4 — Money movement")
        print(f"  matched high-confidence pairs: {step4['pairs_high']}")
        print(f"  matched low-confidence pairs:  {step4['pairs_low']}")
        print(f"  matched card payments:         {step4['card_payments']}")
        print(f"  outside transfer rows: {sum(step4['outside_counts'].values())}")
        print(f"  payment_app rows:      {sum(step4['payment_app_counts'].values())}")
        print(f"  credit_line rows:      {sum(step4['credit_line_counts'].values())}")
        print(f"  unpaired transfer groups (top 10 by rows):")
        for k, ids in sorted(step4["unpaired_groups"].items(),
                              key=lambda x: -len(x[1]))[:10]:
            print(f"    {k[:70]:<70}  rows={len(ids)}")

        print(f"\nStep 4 vs live transfer_pair_id:")
        print(f"  live pairs:              {xfer['live_pairs']}")
        print(f"  lab  pairs:              {xfer['lab_pairs']}")
        print(f"  pairs found by both:     {xfer['pairs_found_by_both']}")
        print(f"  live-only:               {xfer['live_only_pairs']}")
        print(f"  lab-only:                {xfer['lab_only_pairs']}")
        if xfer["lab_only_examples"]:
            print(f"  lab-only examples (first 5):")
            for ex in xfer["lab_only_examples"]:
                print(f"    {ex}")
        if xfer["live_only_examples"]:
            print(f"  live-only examples (first 5):")
            for ex in xfer["live_only_examples"]:
                print(f"    {ex}")
        print(f"\nFull JSON: {out}\n")


if __name__ == "__main__":
    asyncio.run(main())
