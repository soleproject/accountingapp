"""Step 2 final report — Brand Registry & Contact Stamping.

Run:
    python -m scripts.step2_report

What it does:
  1. Enables ``features.brand_registry_v2`` on Test 519 LLC (only)
     if it's not already on.
  2. Runs a SHADOW pass: for every txn on the window (last N days),
     figure out whether the new INDN block and advanced name
     normalizer would have created / matched a contact differently
     than the live resolver already did. Writes results to
     ``contact_resolver_shadow`` (never touches live data).
  3. Runs the audit preview twice (approved-only, approved+candidates)
     via the Step 2 classifier.
  4. Runs a merge-suggestion pass over the company's contacts using
     the deterministic normalizer; adds LLM opinions to the top-N
     borderline pairs.
  5. Writes the full report to ``/tmp/step2_report_<companyid>.json``
     and prints the "before vs. after" summary block.

Idempotent — safe to re-run. LLM cache means repeat runs cost ~0.
"""
from __future__ import annotations
import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Allow "python -m scripts.step2_report" from /app/backend
sys.path.insert(0, "/app/backend")

from db import db
from advanced_features import get_features
from brand_registry import (
    ensure_indexes as _br_ensure,
    seed_admin_defaults as _br_seed,
    counts_by_status,
    lookup_many,
    _norm as _brand_norm,
)
from paypal_parser import has_indn, extract_indn, classify_boa_paypal_row
from name_normalizer_v2 import merge_signal, looks_like_person, canonical_person_key
from shadow_log import log_diff, summarize as summarize_shadow
from brand_llm import merge_suggestion, BrandLLMStats
from reviewv2_step2 import Step2Classifier, get_settings

log = logging.getLogger("axiom.step2_report")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

TEST_COMPANY_NAME = "Test 519 LLC"


async def _find_test_company() -> dict | None:
    return await db.companies.find_one({"name": TEST_COMPANY_NAME})


async def _dump_candidates(limit: int = 200) -> list[dict]:
    out: list[dict] = []
    async for c in db.brand_registry.find({"status": "candidate"}) \
            .sort("created_at", -1).limit(limit):
        out.append({
            "canonical_name": c.get("canonical_name"),
            "merchant_type":  c.get("merchant_type"),
            "category_hint":  c.get("category_hint"),
            "aliases":        (c.get("aliases") or [])[:5],
            "llm_reason":     c.get("llm_reason"),
            "created_at":     c.get("created_at"),
        })
    return out


async def enable_feature_flag(cid: str) -> None:
    features = await get_features(cid)
    if features.get("brand_registry_v2"):
        log.info("brand_registry_v2 already ON for %s", cid)
        return
    await db.companies.update_one(
        {"id": cid},
        {"$set": {"features.brand_registry_v2": True}},
    )
    log.info("brand_registry_v2 flipped ON for %s", cid)


# --------------------------------------------------------------- shadow

async def shadow_indn_pass(cid: str, window_days: int) -> dict:
    """For every txn on this company with an INDN: value, check what
    the live contact_resolver did (via ``contacts`` linked to the txn)
    and log a shadow diff if the new INDN rule would have skipped
    contact creation."""
    since = (datetime.now(timezone.utc) - timedelta(days=window_days)).isoformat()
    would_block = 0
    matches_live = 0
    async for t in db.transactions.find({
        "company_id": cid,
        "date":       {"$gte": since},
    }, {
        "id": 1, "description": 1, "contact_id": 1, "contact_name": 1,
        "merchant": 1, "amount": 1, "date": 1, "original_description": 1,
    }):
        desc = t.get("original_description") or t.get("description") or ""
        if not has_indn(desc):
            continue
        indn = extract_indn(desc) or ""
        live_name = t.get("contact_name") or ""
        # Would the new rule have blocked a contact being made from the INDN?
        # Yes if the current contact's name is derived from that INDN value.
        if live_name and (indn.lower().split() and
                          live_name.lower().find(indn.lower().split()[0]) >= 0):
            would_block += 1
            await log_diff(
                company_id=cid,
                kind="indn_would_block",
                description=desc[:180],
                would_do="skip contact creation from INDN",
                live_did=f"linked to contact '{live_name}'",
                context={
                    "txn_id":   t.get("id"),
                    "date":     t.get("date"),
                    "amount":   t.get("amount"),
                    "indn":     indn,
                },
            )
        else:
            matches_live += 1
    return {
        "would_block_new_contacts": would_block,
        "already_matches_live":     matches_live,
    }


async def shadow_normalizer_pass(cid: str) -> dict:
    """Iterate over pairs of contacts on this company; log every
    positive merge signal from the deterministic normalizer. LLM
    opinions are added by :func:`merge_pass_llm`.

    Runs O(n²) pairs — capped at 300 contacts to keep the pass fast.
    """
    contacts = [c async for c in db.contacts.find({"company_id": cid},
                {"id": 1, "name": 1, "display_name": 1}).limit(300)]
    would_merge = 0
    for i in range(len(contacts)):
        for j in range(i + 1, len(contacts)):
            a = contacts[i].get("name") or contacts[i].get("display_name") or ""
            b = contacts[j].get("name") or contacts[j].get("display_name") or ""
            ok, reason = merge_signal(a, b)
            if ok:
                would_merge += 1
                await log_diff(
                    company_id=cid,
                    kind="normalizer_would_merge",
                    description=f"'{a}' + '{b}'",
                    would_do=f"suggest merge: {reason}",
                    live_did="two separate contacts on the book",
                    context={
                        "contact_a_id": contacts[i].get("id"),
                        "contact_b_id": contacts[j].get("id"),
                        "reason":       reason,
                    },
                )
    return {"contacts_scanned": len(contacts),
            "positive_merge_signals": would_merge}


async def merge_pass_llm(cid: str, max_calls: int = 25) -> list[dict]:
    """For every deterministic-positive merge pair, ask the LLM. Kept
    small to keep cost bounded. Returns the LLM-augmented list."""
    stats = BrandLLMStats()
    out: list[dict] = []
    seen = set()
    async for diff in db.contact_resolver_shadow.find({
        "company_id": cid,
        "kind":       "normalizer_would_merge",
    }).sort("created_at", -1).limit(max_calls):
        pair = tuple(sorted([
            diff.get("context", {}).get("contact_a_id") or "",
            diff.get("context", {}).get("contact_b_id") or "",
        ]))
        if pair in seen:
            continue
        seen.add(pair)
        # Extract names from the description "'A' + 'B'"
        desc = diff.get("description", "")
        a, _, b = desc.partition("' + '")
        a = a.lstrip("'").rstrip("'")
        b = b.rstrip("'")
        llm = await merge_suggestion(name_a=a, name_b=b, stats=stats)
        out.append({
            "a": a, "b": b,
            "deterministic_reason": diff.get("context", {}).get("reason"),
            "llm": llm,
        })
    return out


# --------------------------------------------------------------- main

async def call_preview(cid: str, include: str) -> dict:
    """Call the audit-preview-v2 pipeline in-process (no HTTP)."""
    from reviewv2_step2 import Step2Classifier
    from routes.reviewv2 import (
        _load_connected_account_ids, _is_connected_asset,
        _load_reviewv2_config, _canonical_from_txn_for_median,
    )
    import statistics as _stats

    config = await _load_reviewv2_config(cid)
    settings = await get_settings(cid)
    accts_by_id = {a["id"]: a async for a in db.accounts.find({"company_id": cid})}
    connected_ids = await _load_connected_account_ids(cid)
    for aid, a in accts_by_id.items():
        if _is_connected_asset(a):
            connected_ids.add(aid)
    since = (datetime.now(timezone.utc) - timedelta(days=config["window_days"])).isoformat()
    txns = [t async for t in db.transactions.find({
        "company_id": cid, "date": {"$gte": since},
    }).limit(2000)]

    medians: dict[str, list[float]] = {}
    for t in txns:
        canon = _canonical_from_txn_for_median(t)
        if canon:
            medians.setdefault(_brand_norm(canon), []).append(abs(float(t.get("amount") or 0)))
    merchant_medians = {k: _stats.median(v) for k, v in medians.items() if len(v) >= 3}

    transfer_pair_map: dict[str, list[dict]] = {}
    for t in txns:
        pid = t.get("transfer_pair_id")
        if pid:
            transfer_pair_map.setdefault(pid, []).append(t)

    approved_sample = [
        r["canonical_name"] async for r in db.brand_registry
        .find({"status": "approved"}, {"canonical_name": 1}).limit(120)
    ]

    classifier = Step2Classifier(
        company_id=cid,
        connected_ids=connected_ids,
        accts_by_id=accts_by_id,
        settings=settings,
        include_candidates=(include == "approved+candidates"),
        approved_sample=approved_sample,
        merchant_medians=merchant_medians,
    )
    rows = []
    for t in txns:
        rows.append(await classifier.classify(t, transfer_pair_map=transfer_pair_map))

    def _bucket(rs):
        b = {"auto": [], "always_review": [], "stage1": [], "stage2": [], "stage3": []}
        for r in rs:
            b.setdefault(r["stage"], []).append(r)
        return b, {k: len(v) for k, v in b.items()}, {
            k: round(sum(abs(float(r.get("amount") or 0)) for r in v), 2)
            for k, v in b.items()
        }

    buckets, counts, dollars = _bucket(rows)
    return {
        "include":   include,
        "scanned":   len(txns),
        "counts":    counts,
        "dollars":   dollars,
        "buckets":   buckets,
        "classifier": classifier,
    }


async def build_before_snapshot(cid: str, window_days: int) -> dict:
    """A crude "before" — the OLD verification-based audit-preview
    (no brand registry / LLM). Uses the existing legacy classifier for
    a fair comparison."""
    from routes.reviewv2 import (
        _classify, _load_connected_account_ids, _load_reviewv2_config,
        _load_merchant_rules, _is_connected_asset, _canonical_merchant,
    )
    import statistics as _stats

    config = await _load_reviewv2_config(cid)
    rules = await _load_merchant_rules(cid)
    accts_by_id = {a["id"]: a async for a in db.accounts.find({"company_id": cid})}
    connected_ids = await _load_connected_account_ids(cid)
    for aid, a in accts_by_id.items():
        if _is_connected_asset(a):
            connected_ids.add(aid)
    since = (datetime.now(timezone.utc) - timedelta(days=window_days)).isoformat()
    txns = [t async for t in db.transactions.find({
        "company_id": cid, "date": {"$gte": since},
    }).limit(2000)]

    per_merchant: dict[str, list[float]] = {}
    for t in txns:
        k = _canonical_merchant(t.get("description", ""), t.get("merchant", ""))
        if k:
            per_merchant.setdefault(k, []).append(abs(float(t.get("amount") or 0)))
    merchant_norms = {k: _stats.median(v) for k, v in per_merchant.items() if len(v) >= 3}

    counts = {"auto": 0, "always_review": 0, "stage1": 0, "stage2": 0, "stage3": 0}
    dollars = dict(counts)
    for t in txns:
        b, _r = _classify(t, connected_ids, rules, config, accts_by_id, merchant_norms)
        if b.startswith("AUTO_"):
            key = "auto"
        elif b == "REVIEW_ALWAYS_REVIEW":
            key = "always_review"
        elif b == "REVIEW_STAGE1":
            key = "stage1"
        elif b == "REVIEW_STAGE2":
            key = "stage2"
        elif b == "REVIEW_STAGE3":
            key = "stage3"
        elif b == "_TRANSFER_LEG":
            key = "auto"  # legacy assumed auto here; only informational
        else:
            key = "stage3"
        counts[key] += 1
        dollars[key] = round(dollars[key] + abs(float(t.get("amount") or 0)), 2)
    return {"scanned": len(txns), "counts": counts, "dollars": dollars}


async def main() -> None:
    await _br_ensure()
    await _br_seed()
    company = await _find_test_company()
    if not company:
        raise SystemExit(f"Company '{TEST_COMPANY_NAME}' not found in DB.")
    cid = company["id"]
    log.info("Test company: %s (%s)", company["name"], cid)

    await enable_feature_flag(cid)

    # Window from persisted config or default (90 days)
    from routes.reviewv2 import _load_reviewv2_config
    config = await _load_reviewv2_config(cid)
    window_days = int(config.get("window_days") or 90)

    before = await build_before_snapshot(cid, window_days)
    log.info("BEFORE (legacy classifier): %s", before["counts"])

    # Shadow passes
    indn_shadow = await shadow_indn_pass(cid, window_days)
    norm_shadow = await shadow_normalizer_pass(cid)
    log.info("Shadow: INDN would block %d, normalizer merge signals %d",
             indn_shadow["would_block_new_contacts"],
             norm_shadow["positive_merge_signals"])

    approved_only = await call_preview(cid, "approved")
    approved_plus = await call_preview(cid, "approved+candidates")

    merge_llm = await merge_pass_llm(cid, max_calls=25)

    shadow_summary = await summarize_shadow(cid)
    reg_counts = await counts_by_status()

    # Build the report artifact. Strip classifier object before dumping.
    def _strip(pass_result: dict) -> dict:
        cls: Step2Classifier = pass_result.pop("classifier")
        pass_result["new_candidates"]      = cls.new_candidates
        pass_result["paypal_id_diagnostic"] = [
            {"id": k, "count": v,
             "matched_to": cls.paypal_id_matched_to.get(k, "(unmatched)")}
            for k, v in sorted(cls.paypal_id_seen.items(),
                               key=lambda kv: kv[1], reverse=True)
        ]
        pass_result["other_bank_paypal_rows"] = cls.other_bank_paypal_rows[:20]
        pass_result["llm_usage"] = cls.stats.as_dict()
        # Cap buckets before dumping — long list is not useful.
        for k in list(pass_result["buckets"].keys()):
            pass_result["buckets"][k] = pass_result["buckets"][k][:200]
        return pass_result

    approved_only_stripped = _strip(approved_only)
    approved_plus_stripped = _strip(approved_plus)

    # Random samples pulled from approved+candidates auto pool.
    import random
    auto_pool = approved_plus_stripped["buckets"].get("auto", [])
    sample_verified = random.sample(auto_pool, min(20, len(auto_pool)))
    fits_false = [
        r for r in (approved_plus_stripped["buckets"].get("always_review", [])
                    + approved_plus_stripped["buckets"].get("stage2", [])
                    + approved_plus_stripped["buckets"].get("stage3", []))
        if r.get("review_reason") == "category_mismatch"
    ]
    sample_fits_false = random.sample(fits_false, min(10, len(fits_false)))

    # Top review reasons (from approved+candidates)
    reason_agg: dict[str, dict] = {}
    for stage in ("always_review", "stage1", "stage2", "stage3"):
        for r in approved_plus_stripped["buckets"].get(stage, []):
            rr = r.get("review_reason")
            if not rr:
                continue
            s = reason_agg.setdefault(rr, {"count": 0, "amount": 0.0})
            s["count"] += 1
            s["amount"] += abs(float(r.get("amount") or 0))
    top_reasons = sorted(
        [{"reason": k, "count": v["count"], "amount": round(v["amount"], 2)}
         for k, v in reason_agg.items()],
        key=lambda x: x["count"], reverse=True,
    )[:10]

    report = {
        "company":            {"id": cid, "name": company["name"]},
        "window_days":        window_days,
        "generated_at":       datetime.now(timezone.utc).isoformat(),
        "before":             before,
        "after": {
            "approved_only":         {
                "counts":  approved_only_stripped["counts"],
                "dollars": approved_only_stripped["dollars"],
                "llm_usage": approved_only_stripped["llm_usage"],
            },
            "approved_plus_candidates": {
                "counts":  approved_plus_stripped["counts"],
                "dollars": approved_plus_stripped["dollars"],
                "llm_usage": approved_plus_stripped["llm_usage"],
            },
        },
        "top_review_reasons":  top_reasons,
        "sample_verified":     sample_verified,
        "sample_fits_false":   sample_fits_false,
        "new_candidates":      approved_plus_stripped["new_candidates"],
        "registry_candidates_in_db": await _dump_candidates(),
        "paypal_id_diagnostic": approved_plus_stripped["paypal_id_diagnostic"],
        "other_bank_paypal_rows": approved_plus_stripped["other_bank_paypal_rows"],
        "merge_suggestions_llm": merge_llm,
        "shadow_diffs":        shadow_summary,
        "shadow_summary_counts": {
            "indn": indn_shadow,
            "normalizer": norm_shadow,
        },
        "registry_counts":     reg_counts,
    }

    out_path = Path(f"/tmp/step2_report_{cid}.json")
    out_path.write_text(json.dumps(report, indent=2, default=str))
    log.info("Report written to %s", out_path)

    # Print the summary block
    print("\n" + "=" * 60)
    print(f"STEP 2 REPORT — {company['name']} (window {window_days}d)")
    print("=" * 60)
    print("BEFORE (legacy):")
    for k, v in before["counts"].items():
        print(f"  {k:>18}: {v:>5}  ${before['dollars'][k]:>10,.2f}")
    print("\nAFTER (approved-only):")
    ao = approved_only_stripped
    for k, v in ao["counts"].items():
        print(f"  {k:>18}: {v:>5}  ${ao['dollars'][k]:>10,.2f}")
    print("\nAFTER (approved + candidates):")
    ap = approved_plus_stripped
    for k, v in ap["counts"].items():
        print(f"  {k:>18}: {v:>5}  ${ap['dollars'][k]:>10,.2f}")
    print(f"\nTop review reasons:")
    for row in top_reasons:
        print(f"  {row['reason']:<30} {row['count']:>4}  ${row['amount']:>10,.2f}")
    print(f"\nNew registry candidates (proposed this run + prior): "
          f"{reg_counts.get('candidate', 0)}")
    print(f"Distinct PayPal IDs seen: {len(approved_plus_stripped['paypal_id_diagnostic'])}")
    print(f"Other-bank PayPal rows:   {len(approved_plus_stripped['other_bank_paypal_rows'])}")
    print(f"LLM usage (approved+cand): {ap['llm_usage']}")
    print(f"Shadow diffs: INDN={indn_shadow['would_block_new_contacts']} "
          f"NormalizerMerges={norm_shadow['positive_merge_signals']}")
    print(f"Registry counts: {reg_counts}")
    print(f"\nFull JSON: {out_path}\n")


if __name__ == "__main__":
    asyncio.run(main())
