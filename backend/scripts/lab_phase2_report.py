"""Phase 2 report — end-to-end run for a single company + full diagnostics.

Executes Phase 1 (idempotent — skipped if already run) then Phase 2, then
compiles the report spec (Feb 2026, item #11):

    * contact_source distribution
    * contacts the lab would CREATE vs live (count + up to 30 examples)
    * INDN-derived live contacts the lab skips (COMPUTED, not hardcoded)
    * blank contacts by channel
    * merge suggestions with reasons
    * live vs lab contact differences (count + 20 random examples)
    * Enrich rows per source and coverage before/after
    * LLM usage (rows reaching LLM, cache hits, calls)
    * total run time
"""
from __future__ import annotations
import argparse, asyncio, json, random, re, sys, time
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from dotenv import load_dotenv
load_dotenv()

from db import db
from lab_pipeline.runner import run_phase1, run_phase2
from lab_pipeline.collections import (
    LAB_TRANSACTIONS, LAB_CONTACTS, LAB_MERGE_SUGGESTIONS,
    LAB_ENRICH_CACHE, LAB_LLM_CACHE,
)
from contact_resolver import _INDN_RX


async def _indn_derived_live(company_id: str) -> list[dict]:
    """Compute (deterministically) the set of LIVE contacts whose name
    matches the INDN capture on at least one linked transaction. This
    is what the lab would refuse to mint (spec #6)."""
    live = {c["id"]: c async for c in db.contacts.find(
        {"company_id": company_id}, {"id": 1, "name": 1})}
    hits: dict[str, dict] = {}
    async for t in db.transactions.find(
        {"company_id": company_id, "contact_id": {"$ne": None}},
        {"description": 1, "contact_id": 1, "id": 1, "date": 1},
    ):
        desc = t.get("description") or ""
        if "INDN" not in desc.upper():
            continue
        m = _INDN_RX.search(desc)
        if not m:
            continue
        indn = re.sub(r"\s+", " ", m.group(1)).strip().title()
        c = live.get(t.get("contact_id")) or {}
        cname = (c.get("name") or "").strip()
        if not cname or not indn:
            continue
        if cname.lower() == indn.lower():
            hits.setdefault(c["id"], {
                "contact_id":   c["id"],
                "contact_name": cname,
                "indn_capture": indn,
                "example_txn":  t.get("id"),
                "example_date": t.get("date"),
            })
    return sorted(hits.values(), key=lambda x: x["contact_name"].lower())


async def _blank_contacts_by_channel(company_id: str) -> dict:
    by_channel: dict[str, int] = {}
    async for r in db[LAB_TRANSACTIONS].find(
        {"company_id": company_id, "contact_source": "unresolved"},
        {"channel": 1},
    ):
        ch = r.get("channel") or "unknown"
        by_channel[ch] = by_channel.get(ch, 0) + 1
    return by_channel


async def _contact_diffs_sample(company_id: str, k: int = 20) -> list[dict]:
    """Random sample of `k` rows where live.contact != lab.contact."""
    live_names: dict[str, str] = {
        c["id"]: (c.get("name") or "")
        async for c in db.contacts.find({"company_id": company_id},
                                        {"id": 1, "name": 1})
    }
    diffs: list[dict] = []
    async for r in db[LAB_TRANSACTIONS].find(
        {"company_id": company_id},
        {"txn_id": 1, "date": 1, "description_live": 1,
         "contact_id_live": 1, "contact_name_live": 1,
         "contact": 1, "contact_source": 1, "channel": 1, "movement_type": 1},
    ):
        live = (live_names.get(r.get("contact_id_live"), "")
                or r.get("contact_name_live") or "").strip()
        lab  = (r.get("contact") or "").strip()
        if live.lower() == lab.lower():
            continue
        diffs.append({
            "txn_id":         r.get("txn_id"),
            "date":           r.get("date"),
            "description":    r.get("description_live"),
            "live":           live or None,
            "lab":            lab or None,
            "contact_source": r.get("contact_source"),
            "channel":        r.get("channel"),
            "movement_type":  r.get("movement_type"),
        })
    total = len(diffs)
    sample = random.sample(diffs, min(k, len(diffs))) if diffs else []
    return {"count": total, "sample": sample}


async def _enrich_coverage(company_id: str) -> dict:
    """Before/after coverage numbers for the Enrich pass."""
    total = await db.transactions.count_documents({"company_id": company_id})
    by_source: dict[str, int] = {}
    async for r in db.transactions.aggregate([
        {"$match": {"company_id": company_id}},
        {"$group": {"_id": "$source", "n": {"$sum": 1}}},
    ]):
        by_source[r.get("_id") or "unknown"] = r["n"]
    enrichable = sum(v for k, v in by_source.items() if k != "plaid")
    cached_rows = await db[LAB_ENRICH_CACHE].count_documents({"company_id": company_id})
    covered = await db[LAB_TRANSACTIONS].count_documents({
        "company_id": company_id, "enrich_cache_key": {"$ne": None},
    })
    return {
        "total_rows":         total,
        "by_source":          by_source,
        "enrichable_rows":    enrichable,
        "cache_rows":         cached_rows,
        "rows_with_cache_key": covered,
    }


async def _llm_usage(company_id: str) -> dict:
    """LLM usage summary — rows reaching LLM, cache hits, calls."""
    total = await db[LAB_TRANSACTIONS].count_documents({"company_id": company_id})
    reached_llm = await db[LAB_TRANSACTIONS].count_documents({
        "company_id": company_id,
        "contact_source": {"$in": ["llm_pending", "llm_match_live",
                                    "llm_new", "unresolved"]},
    })
    cache_rows = await db[LAB_LLM_CACHE].count_documents({"company_id": company_id})
    return {
        "total_rows":          total,
        "rows_reaching_llm":   reached_llm,
        "pct_reaching_llm":    round(100.0 * reached_llm / total, 2) if total else 0,
        "llm_cache_rows":      cache_rows,
    }


async def _lab_new_contacts_sample(company_id: str, k: int = 30) -> dict:
    total = await db[LAB_CONTACTS].count_documents({"company_id": company_id})
    docs = [d async for d in db[LAB_CONTACTS].find(
        {"company_id": company_id}, {"_id": 0}).sort("last_updated", -1).limit(k)]
    return {"count": total, "sample": docs}


async def _merge_suggestions(company_id: str) -> list[dict]:
    return [d async for d in db[LAB_MERGE_SUGGESTIONS].find(
        {"company_id": company_id}, {"_id": 0}
    ).limit(200)]


async def _contact_source_distribution(company_id: str) -> dict:
    dist: dict[str, int] = {}
    async for r in db[LAB_TRANSACTIONS].aggregate([
        {"$match": {"company_id": company_id}},
        {"$group": {"_id": "$contact_source", "n": {"$sum": 1}}},
    ]):
        dist[r["_id"] or "none"] = r["n"]
    return dist


async def main(company_id: str, *, out: str, run_llm: bool = True) -> None:
    t0 = time.time()
    print(f"[phase2] running Phase 1 for {company_id}…")
    r1 = await run_phase1(company_id)
    if not r1.get("ok"):
        print("Phase 1 refused:", r1)
        sys.exit(1)

    print(f"[phase2] running Phase 2 for {company_id} (run_llm={run_llm})…")
    r2 = await run_phase2(company_id, run_llm=run_llm)
    if not r2.get("ok"):
        print("Phase 2 refused:", r2)
        sys.exit(2)

    print("[phase2] gathering report…")
    dist          = await _contact_source_distribution(company_id)
    diffs         = await _contact_diffs_sample(company_id, k=20)
    indn_skipped  = await _indn_derived_live(company_id)
    blank_by_ch   = await _blank_contacts_by_channel(company_id)
    lab_new       = await _lab_new_contacts_sample(company_id, k=30)
    merges        = await _merge_suggestions(company_id)
    enrich_cov    = await _enrich_coverage(company_id)
    llm_usage     = await _llm_usage(company_id)

    report = {
        "company_id":                company_id,
        "generated_at":              datetime.now(timezone.utc).isoformat(),
        "total_duration_s":          round(time.time() - t0, 3),
        "phase1_summary":            r1,
        "phase2_summary":            r2,
        "contact_source_distribution": dist,
        "contacts_lab_would_create": lab_new,
        "indn_derived_live_skipped": {
            "count":  len(indn_skipped),
            "sample": indn_skipped[:20],
        },
        "blank_contacts_by_channel": blank_by_ch,
        "merge_suggestions":         {
            "count":  len(merges),
            "sample": merges[:20],
        },
        "live_vs_lab_contact_diffs": diffs,
        "enrich_coverage":           enrich_cov,
        "llm_usage":                 llm_usage,
    }
    with open(out, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"[phase2] wrote {out}  ({round(time.time()-t0,2)}s)")

    # Short console summary
    print("\n=== Phase 2 summary ===")
    print(f"  contact_source_distribution: {dist}")
    print(f"  contacts lab would create: {lab_new['count']}")
    print(f"  INDN-derived live contacts SKIPPED: {len(indn_skipped)}")
    print(f"  blank contacts by channel: {blank_by_ch}")
    print(f"  merge suggestions: {len(merges)}")
    print(f"  live-vs-lab contact diffs: {diffs['count']}")
    print(f"  enrich: {enrich_cov}")
    print(f"  llm: {llm_usage}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("company_id")
    parser.add_argument("--out", default=None)
    parser.add_argument("--no-llm", action="store_true",
                        help="Skip Claude Haiku fallback (dev only).")
    args = parser.parse_args()
    out = args.out or f"/tmp/lab_phase2_{args.company_id}.json"
    asyncio.run(main(args.company_id, out=out, run_llm=not args.no_llm))
