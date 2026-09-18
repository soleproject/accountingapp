"""Phase 3 report — Steps 6-8 output for a single company.

STANDARD SHORT REPORT per Feb-2026 spec cut:
    * rows auto-booked vs needing review (count, $, %)
    * questions per company by stage (review_reason)
    * live-vs-lab differences count with 10 random examples
    * LLM % of rows, calls, cost estimate
    * run time

Anything more (top-cards, category-mismatch samples, per-contact
breakdowns) is EXPLICITLY deferred until asked.
"""
from __future__ import annotations
import argparse, asyncio, json, random, sys, time
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")
from dotenv import load_dotenv
load_dotenv()

from db import db
from lab_pipeline.runner import run_phase1, run_phase2, run_phase3
from lab_pipeline.collections import LAB_TRANSACTIONS, LAB_LLM_CACHE

# Emergent Claude Haiku 4.5 token cost approximation (USD per call).
# ~$0.80/M input + $4/M output; we send ~300 tokens in, ~50 out avg.
_HAIKU_COST_PER_CALL = 0.0004


async def _auto_book_vs_review(company_id: str) -> dict:
    total = await db[LAB_TRANSACTIONS].count_documents({"company_id": company_id})
    auto_rows = 0
    auto_sum = 0.0
    review_rows = 0
    review_sum = 0.0
    async for r in db[LAB_TRANSACTIONS].find(
        {"company_id": company_id},
        {"verified": 1, "review_reason": 1, "amount": 1},
    ):
        amt = abs(float(r.get("amount") or 0))
        if r.get("verified") is True:
            auto_rows += 1
            auto_sum += amt
        elif r.get("review_reason"):
            review_rows += 1
            review_sum += amt
    return {
        "total":       total,
        "auto_rows":   auto_rows,
        "auto_sum":    round(auto_sum, 2),
        "auto_pct":    round(100.0 * auto_rows / total, 2) if total else 0,
        "review_rows": review_rows,
        "review_sum":  round(review_sum, 2),
        "review_pct":  round(100.0 * review_rows / total, 2) if total else 0,
    }


async def _questions_by_stage(company_id: str) -> dict:
    """Count UNIQUE review_card_keys per review_reason (question count),
    plus row count and dollar sum per reason."""
    out: dict[str, dict] = {}
    async for r in db[LAB_TRANSACTIONS].find(
        {"company_id": company_id, "review_reason": {"$ne": None}},
        {"review_reason": 1, "review_card_key": 1, "amount": 1},
    ):
        rr = r["review_reason"]
        d = out.setdefault(rr, {"rows": 0, "sum": 0.0, "card_keys": set()})
        d["rows"] += 1
        d["sum"] += abs(float(r.get("amount") or 0))
        if r.get("review_card_key"):
            d["card_keys"].add(r["review_card_key"])
    return {
        rr: {
            "questions": len(v["card_keys"]),
            "rows":      v["rows"],
            "sum":       round(v["sum"], 2),
        }
        for rr, v in out.items()
    }


async def _live_vs_lab_diffs(company_id: str, k: int = 10) -> dict:
    """A row differs if live.contact != lab.contact OR live.category != lab.category."""
    live_contacts: dict[str, str] = {
        c["id"]: (c.get("name") or "")
        async for c in db.contacts.find({"company_id": company_id},
                                        {"id": 1, "name": 1})
    }
    live_accounts: dict[str, str] = {
        a["id"]: (a.get("name") or "")
        async for a in db.accounts.find({"company_id": company_id},
                                        {"id": 1, "name": 1})
    }
    diffs: list[dict] = []
    async for r in db[LAB_TRANSACTIONS].find(
        {"company_id": company_id},
        {"txn_id": 1, "date": 1, "description_live": 1,
         "contact_id_live": 1, "contact_name_live": 1,
         "contact": 1, "contact_source": 1,
         "category_account_id_live": 1, "category": 1, "category_source": 1,
         "review_reason": 1, "amount": 1},
    ):
        live_c = (live_contacts.get(r.get("contact_id_live"), "")
                  or r.get("contact_name_live") or "").strip()
        lab_c  = (r.get("contact") or "").strip()
        live_cat  = live_accounts.get(r.get("category_account_id_live"), "").strip()
        lab_cat_obj = r.get("category") or {}
        lab_cat = (lab_cat_obj.get("account_name") or "").strip()
        contact_diff  = live_c.lower() != lab_c.lower()
        category_diff = live_cat.lower() != lab_cat.lower()
        if not (contact_diff or category_diff):
            continue
        diffs.append({
            "txn_id":         r.get("txn_id"),
            "date":           r.get("date"),
            "description":    r.get("description_live"),
            "amount":         r.get("amount"),
            "live_contact":   live_c or None,
            "lab_contact":    lab_c or None,
            "live_category":  live_cat or None,
            "lab_category":   lab_cat or None,
            "contact_source": r.get("contact_source"),
            "category_source": r.get("category_source"),
            "review_reason":  r.get("review_reason"),
        })
    return {
        "count":  len(diffs),
        "sample": random.sample(diffs, min(k, len(diffs))) if diffs else [],
    }


async def _llm_usage(company_id: str, step7_stats: dict) -> dict:
    total = await db[LAB_TRANSACTIONS].count_documents({"company_id": company_id})
    step7_calls = int(step7_stats.get("llm_calls") or 0)
    step7_hits  = int(step7_stats.get("llm_cache_hits") or 0)
    cache_rows  = await db[LAB_LLM_CACHE].count_documents(
        {"company_id": company_id, "cache_key": {"$regex": "^step7::"}})
    return {
        "total_rows":      total,
        "step7_calls":     step7_calls,
        "step7_cache_hits": step7_hits,
        "step7_cache_rows": cache_rows,
        "pct_rows_reaching_llm": round(100.0 * (step7_calls + step7_hits) / total, 2) if total else 0,
        "estimated_cost_usd":    round(step7_calls * _HAIKU_COST_PER_CALL, 4),
    }


async def main(company_id: str, *, out: str, run_llm: bool = True) -> None:
    t0 = time.time()
    print(f"[phase3] Phase 1 for {company_id}…")
    r1 = await run_phase1(company_id)
    if not r1.get("ok"):
        print("Phase 1 refused:", r1); sys.exit(1)
    print(f"[phase3] Phase 2 for {company_id}…")
    r2 = await run_phase2(company_id, run_llm=run_llm)
    if not r2.get("ok"):
        print("Phase 2 refused:", r2); sys.exit(2)
    print(f"[phase3] Phase 3 for {company_id} (run_llm={run_llm})…")
    r3 = await run_phase3(company_id, run_llm=run_llm)
    if not r3.get("ok"):
        print("Phase 3 refused:", r3); sys.exit(3)

    auto     = await _auto_book_vs_review(company_id)
    stages   = await _questions_by_stage(company_id)
    diffs    = await _live_vs_lab_diffs(company_id, k=10)
    llm_use  = await _llm_usage(company_id, r3.get("step7") or {})

    report = {
        "company_id":     company_id,
        "generated_at":   datetime.now(timezone.utc).isoformat(),
        "total_duration_s": round(time.time() - t0, 3),
        "phase3_summary": r3,
        "auto_book_vs_review": auto,
        "questions_by_stage":  stages,
        "live_vs_lab_diffs":   diffs,
        "llm_usage":           llm_use,
    }
    with open(out, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"[phase3] wrote {out}  ({round(time.time()-t0,2)}s)")

    print("\n=== Phase 3 short report ===")
    print(f"  auto-booked: {auto['auto_rows']}/{auto['total']} ({auto['auto_pct']}%) — ${auto['auto_sum']:,.2f}")
    print(f"  needs review: {auto['review_rows']} ({auto['review_pct']}%) — ${auto['review_sum']:,.2f}")
    print("  questions by stage:")
    for k, v in sorted(stages.items()):
        print(f"    {k:<28} questions={v['questions']:>3}  rows={v['rows']:>4}  ${v['sum']:>12,.2f}")
    print(f"  live vs lab diffs: {diffs['count']}")
    print(f"  LLM: {llm_use['step7_calls']} calls · {llm_use['step7_cache_hits']} hits "
          f"· {llm_use['pct_rows_reaching_llm']}% of rows · ~${llm_use['estimated_cost_usd']}")
    print(f"  run time: {report['total_duration_s']}s")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("company_id")
    p.add_argument("--out", default=None)
    p.add_argument("--no-llm", action="store_true")
    args = p.parse_args()
    out = args.out or f"/tmp/lab_phase3_{args.company_id}.json"
    asyncio.run(main(args.company_id, out=out, run_llm=not args.no_llm))
