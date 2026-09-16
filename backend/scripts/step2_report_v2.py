"""Step 2 report v2 — full-history run + all follow-up analyses.

Delivers the checklist from the user's second Step 2 message:

  * Full-history scan (no 90d cap) on Test 519 LLC
  * Bucket counts split by human_reviewed vs still-open
  * top 10 llm_unsure rows with LLM inputs and response
  * llm_unsure cause breakdown
  * stronger-model comparison on 15 llm_unsure rows
  * 20-row auto-handled sample (with verification_reason split)
  * auto-handled count + $ broken out by verification_reason
  * transfer-pair verification: every auto-handled leg + its partner
  * unpaired transfer candidates report
  * PayPal ID diagnostic re-run on the full period
"""
from __future__ import annotations
import asyncio
import json
import logging
import random
import statistics as _stats
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/app/backend")

from db import db
from advanced_features import get_features
from brand_registry import (
    ensure_indexes as _br_ensure,
    seed_admin_defaults as _br_seed,
    counts_by_status,
    _norm as _brand_norm,
)
from brand_llm import (
    BrandLLMStats, identify_merchant, merge_suggestion,
)
from paypal_parser import has_indn, extract_indn
from name_normalizer_v2 import merge_signal
from shadow_log import log_diff, summarize as summarize_shadow
from reviewv2_step2 import Step2Classifier, get_settings, looks_like_transfer

log = logging.getLogger("axiom.step2_report_v2")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

TEST_COMPANY_NAME = "Test 519 LLC"
STRONGER_MODEL = "gpt-4o"  # explicit stronger model for the comparison run


async def _find_test_company():
    return await db.companies.find_one({"name": TEST_COMPANY_NAME})


async def enable_flag(cid: str) -> None:
    features = await get_features(cid)
    if not features.get("brand_registry_v2"):
        await db.companies.update_one(
            {"id": cid}, {"$set": {"features.brand_registry_v2": True}}
        )
        log.info("brand_registry_v2 flipped ON for %s", cid)


async def clear_stale_candidates() -> int:
    """Delete existing status=candidate rows so the new prompt can
    re-classify from scratch. Approved seeds are untouched."""
    res = await db.brand_registry.delete_many({"status": "candidate"})
    log.info("Cleared %d stale candidate rows", res.deleted_count)
    return res.deleted_count


async def clear_llm_cache() -> int:
    """Bumped model version already busts the cache, but proactively
    clear so the report's counts reflect the new prompt directly."""
    res = await db.brand_llm_cache.delete_many({})
    log.info("Cleared %d cached LLM results", res.deleted_count)
    return res.deleted_count


async def load_pass_inputs(cid: str) -> dict:
    """Build the shared inputs the classifier needs (connected accounts,
    txns, medians, transfer_pair_map, approved sample)."""
    from routes.reviewv2 import (
        _load_connected_account_ids, _is_connected_asset,
    )
    accts_by_id = {a["id"]: a async for a in db.accounts.find({"company_id": cid})}
    connected_ids = await _load_connected_account_ids(cid)
    for aid, a in accts_by_id.items():
        if _is_connected_asset(a):
            connected_ids.add(aid)

    txns = [t async for t in db.transactions.find({"company_id": cid}).limit(5000)]
    dates = [t.get("date") for t in txns if t.get("date")]
    date_range = {"min": min(dates) if dates else None,
                  "max": max(dates) if dates else None}
    reviewed_split = {
        "human_reviewed": sum(1 for t in txns if t.get("human_reviewed")),
        "open":           sum(1 for t in txns if not t.get("human_reviewed")),
    }

    medians_raw: dict[str, list[float]] = {}
    for t in txns:
        canon = (t.get("merchant") or "").strip()
        if not canon:
            for cp in (t.get("counterparties") or []):
                if (cp.get("type") or "").lower() == "payment_app":
                    continue
                canon = (cp.get("name") or "").strip()
                if canon:
                    break
        if not canon:
            canon = (t.get("description") or "").strip()[:80]
        if canon:
            medians_raw.setdefault(_brand_norm(canon), []).append(
                abs(float(t.get("amount") or 0))
            )
    merchant_medians = {k: _stats.median(v) for k, v in medians_raw.items() if len(v) >= 3}

    transfer_pair_map: dict[str, list[dict]] = {}
    for t in txns:
        pid = t.get("transfer_pair_id")
        if pid:
            transfer_pair_map.setdefault(pid, []).append(t)

    approved_sample = [
        r["canonical_name"] async for r in db.brand_registry
        .find({"status": "approved"}, {"canonical_name": 1}).limit(120)
    ]
    return {
        "accts_by_id":      accts_by_id,
        "connected_ids":    connected_ids,
        "txns":             txns,
        "medians":          merchant_medians,
        "transfer_pair_map": transfer_pair_map,
        "approved_sample":  approved_sample,
        "date_range":       date_range,
        "reviewed_split":   reviewed_split,
    }


async def run_pass(cid: str, inputs: dict, include_candidates: bool) -> dict:
    settings = await get_settings(cid)
    cls = Step2Classifier(
        company_id=cid,
        connected_ids=inputs["connected_ids"],
        accts_by_id=inputs["accts_by_id"],
        settings=settings,
        include_candidates=include_candidates,
        approved_sample=inputs["approved_sample"],
        merchant_medians=inputs["medians"],
    )
    rows: list[dict] = []
    for t in inputs["txns"]:
        rows.append(await cls.classify(t, transfer_pair_map=inputs["transfer_pair_map"]))
    return {"classifier": cls, "rows": rows}


def bucket(rows: list[dict]) -> dict[str, list[dict]]:
    b = {"auto": [], "always_review": [], "stage1": [], "stage2": [], "stage3": []}
    for r in rows:
        b.setdefault(r["stage"], []).append(r)
    return b


def sum_abs(rows: list[dict]) -> float:
    return round(sum(abs(float(r.get("amount") or 0)) for r in rows), 2)


async def verify_transfer_pairs(rows: list[dict], accts_by_id: dict) -> dict:
    """For every auto-handled transfer leg, confirm bank/account name
    on each leg and count pairs missing a partner."""
    auto_transfers = [r for r in rows if r.get("verification_reason") == "matched_transfer"]
    per_pair: dict[str, list[dict]] = {}
    for r in auto_transfers:
        pid = r.get("extras", {}).get("pair_id")
        if pid:
            per_pair.setdefault(pid, []).append(r)
    incomplete = [pid for pid, legs in per_pair.items() if len(legs) < 2]
    details = []
    for pid, legs in per_pair.items():
        legs_detail = []
        for l in legs:
            a = accts_by_id.get(l.get("bank_account_id")) or {}
            legs_detail.append({
                "bank_account_name": a.get("name"),
                "bank_account_code": a.get("code"),
                "bank_last4":        a.get("bank_last4"),
                "amount":            l.get("amount"),
                "date":              l.get("date"),
                "description":       (l.get("description") or "")[:120],
            })
        details.append({
            "pair_id": pid,
            "leg_count": len(legs),
            "complete": len(legs) >= 2,
            "legs":     legs_detail,
        })
    return {
        "total_auto_transfer_legs": len(auto_transfers),
        "distinct_pairs":            len(per_pair),
        "pairs_with_missing_partner": len(incomplete),
        "pair_details":              details[:30],
    }


async def stronger_model_pass(rows: list[dict], inputs: dict,
                              sample_size: int = 15) -> dict:
    """Take up to `sample_size` llm_unsure rows and re-run
    identify_merchant with the stronger model. Compare + report cost."""
    unsure_rows = [r for r in rows if r.get("review_reason") == "llm_unsure"]
    sample = random.sample(unsure_rows, min(sample_size, len(unsure_rows)))
    stats = BrandLLMStats()
    comparisons = []
    for r in sample:
        # Reconstruct the descriptor/merchant from the outcome extras.
        prompt_inputs = (r.get("extras", {}).get("llm_result") or {}).get("prompt_inputs") or {}
        stronger = await identify_merchant(
            descriptor=prompt_inputs.get("descriptor") or (r.get("description") or ""),
            merchant_field=prompt_inputs.get("merchant_field") or r.get("merchant") or "",
            pfc_detailed=prompt_inputs.get("pfc_detailed") or r.get("pfc_detailed"),
            amount=r.get("amount"),
            approved_registry_sample=inputs["approved_sample"],
            stats=stats,
            model_override=STRONGER_MODEL,
        )
        comparisons.append({
            "txn_id":     r.get("id"),
            "date":       r.get("date"),
            "amount":     r.get("amount"),
            "descriptor": (r.get("description") or "")[:120],
            "merchant":   r.get("merchant"),
            "pfc_detailed": r.get("pfc_detailed"),
            "fast_result": r.get("extras", {}).get("llm_result"),
            "stronger_result": {
                "match":          stronger.get("match"),
                "canonical_name": stronger.get("canonical_name"),
                "merchant_type":  stronger.get("merchant_type"),
                "confidence":     stronger.get("confidence"),
                "unsure_cause":   stronger.get("unsure_cause"),
                "reason":         stronger.get("reason"),
            },
        })
    # Bump the approx-cost multiplier for the stronger model (~10× fast)
    stronger_cost = round(stats.calls_made * 0.0025, 4)
    return {
        "model":          STRONGER_MODEL,
        "sample_size":    len(comparisons),
        "calls_made":     stats.calls_made,
        "cache_hits":     stats.cache_hits,
        "approx_cost_usd": stronger_cost,
        "comparisons":    comparisons,
    }


def split_by_reviewed(rows: list[dict]) -> dict:
    """Return {stage: {reviewed_count, open_count, reviewed_$, open_$}}."""
    out: dict[str, dict] = {}
    for r in rows:
        s = r["stage"]
        slot = out.setdefault(s, {"reviewed_count": 0, "open_count": 0,
                                   "reviewed_dollars": 0.0, "open_dollars": 0.0})
        amt = abs(float(r.get("amount") or 0))
        if r.get("human_reviewed"):
            slot["reviewed_count"] += 1
            slot["reviewed_dollars"] += amt
        else:
            slot["open_count"] += 1
            slot["open_dollars"] += amt
    for slot in out.values():
        slot["reviewed_dollars"] = round(slot["reviewed_dollars"], 2)
        slot["open_dollars"]     = round(slot["open_dollars"], 2)
    return out


def split_by_verification_reason(rows: list[dict]) -> dict:
    """auto-handled count + $ broken out by verification_reason."""
    out: dict[str, dict] = {}
    for r in rows:
        if r["stage"] != "auto":
            continue
        vr = r.get("verification_reason") or "unknown"
        slot = out.setdefault(vr, {"count": 0, "dollars": 0.0})
        slot["count"] += 1
        slot["dollars"] += abs(float(r.get("amount") or 0))
    for slot in out.values():
        slot["dollars"] = round(slot["dollars"], 2)
    return out


def unsure_cause_breakdown(rows: list[dict]) -> dict:
    out: dict[str, int] = {}
    for r in rows:
        if r.get("review_reason") != "llm_unsure":
            continue
        cause = (r.get("extras", {}).get("llm_unsure_cause")
                 or (r.get("extras", {}).get("llm_result") or {}).get("unsure_cause")
                 or "unclassified")
        out[cause] = out.get(cause, 0) + 1
    return out


def top_llm_unsure_rows(rows: list[dict], k: int = 10) -> list[dict]:
    """Return top-K llm_unsure rows by absolute amount, with LLM inputs
    and response included."""
    unsure = [r for r in rows if r.get("review_reason") == "llm_unsure"]
    unsure.sort(key=lambda r: abs(float(r.get("amount") or 0)), reverse=True)
    out = []
    for r in unsure[:k]:
        llm = r.get("extras", {}).get("llm_result") or {}
        out.append({
            "id":          r.get("id"),
            "date":        r.get("date"),
            "amount":      r.get("amount"),
            "descriptor":  (r.get("description") or "")[:180],
            "merchant":    r.get("merchant"),
            "pfc_detailed": r.get("pfc_detailed"),
            "llm_inputs":  llm.get("prompt_inputs"),
            "llm_response": {
                "match":          llm.get("match"),
                "canonical_name": llm.get("canonical_name"),
                "merchant_type":  llm.get("merchant_type"),
                "confidence":     llm.get("confidence"),
                "unsure_cause":   llm.get("unsure_cause"),
                "reason":         llm.get("reason"),
            },
        })
    return out


async def dump_candidates(limit: int = 200) -> list[dict]:
    out = []
    async for c in db.brand_registry.find({"status": "candidate"}) \
            .sort("created_at", -1).limit(limit):
        out.append({
            "canonical_name": c.get("canonical_name"),
            "merchant_type":  c.get("merchant_type"),
            "category_hint":  c.get("category_hint"),
            "personal_risk":  c.get("personal_risk", False),
            "aliases":        (c.get("aliases") or [])[:5],
            "llm_reason":     c.get("llm_reason"),
        })
    return out


async def shadow_indn_full(cid: str) -> dict:
    """Full-history INDN shadow pass — no window filter."""
    would_block = 0
    async for t in db.transactions.find(
        {"company_id": cid}, {
            "id": 1, "description": 1, "contact_id": 1, "contact_name": 1,
            "merchant": 1, "amount": 1, "date": 1,
            "original_description": 1,
        }
    ):
        desc = t.get("original_description") or t.get("description") or ""
        if not has_indn(desc):
            continue
        indn = extract_indn(desc) or ""
        live_name = t.get("contact_name") or ""
        if live_name and indn.lower().split() and \
           live_name.lower().find(indn.lower().split()[0]) >= 0:
            would_block += 1
            await log_diff(
                company_id=cid, kind="indn_would_block",
                description=desc[:180],
                would_do="skip contact creation from INDN",
                live_did=f"linked to contact '{live_name}'",
                context={"txn_id": t.get("id"), "date": t.get("date"),
                         "amount": t.get("amount"), "indn": indn},
            )
    return {"would_block_new_contacts": would_block}


async def shadow_normalizer_full(cid: str) -> dict:
    contacts = [c async for c in db.contacts.find({"company_id": cid},
                {"id": 1, "name": 1}).limit(400)]
    would_merge = 0
    for i in range(len(contacts)):
        for j in range(i + 1, len(contacts)):
            a = contacts[i].get("name") or ""
            b = contacts[j].get("name") or ""
            ok, reason = merge_signal(a, b)
            if ok:
                would_merge += 1
                await log_diff(
                    company_id=cid, kind="normalizer_would_merge",
                    description=f"'{a}' + '{b}'",
                    would_do=f"suggest merge: {reason}",
                    live_did="two separate contacts on the book",
                    context={"contact_a_id": contacts[i].get("id"),
                             "contact_b_id": contacts[j].get("id"),
                             "reason": reason},
                )
    return {"contacts_scanned": len(contacts),
            "positive_merge_signals": would_merge}


async def main() -> None:
    await _br_ensure()
    await _br_seed()
    company = await _find_test_company()
    if not company:
        raise SystemExit(f"Company '{TEST_COMPANY_NAME}' not found.")
    cid = company["id"]
    log.info("Test company: %s (%s)", company["name"], cid)

    await enable_flag(cid)
    await clear_stale_candidates()
    await clear_llm_cache()

    # Full-history run
    inputs = await load_pass_inputs(cid)
    log.info("Scanning %d txns from %s to %s (reviewed=%d open=%d)",
             len(inputs["txns"]),
             inputs["date_range"]["min"], inputs["date_range"]["max"],
             inputs["reviewed_split"]["human_reviewed"],
             inputs["reviewed_split"]["open"])

    log.info("Pass 1: approved-only …")
    approved_only = await run_pass(cid, inputs, include_candidates=False)
    log.info("Pass 2: approved + candidates …")
    approved_plus = await run_pass(cid, inputs, include_candidates=True)

    ap_rows = approved_plus["rows"]
    ao_rows = approved_only["rows"]

    ap_buckets = bucket(ap_rows)
    ao_buckets = bucket(ao_rows)

    # Transfer verification (from approved+candidates pass, same result
    # in both since transfer path is registry-independent).
    xfer_verify = await verify_transfer_pairs(ap_rows, inputs["accts_by_id"])
    log.info("Transfer pairs: %d distinct, %d auto legs, %d missing partners",
             xfer_verify["distinct_pairs"],
             xfer_verify["total_auto_transfer_legs"],
             xfer_verify["pairs_with_missing_partner"])

    # Shadow passes (full history)
    indn_sh = await shadow_indn_full(cid)
    norm_sh = await shadow_normalizer_full(cid)

    # Stronger model comparison — run against approved+candidates rows
    stronger = await stronger_model_pass(ap_rows, inputs, sample_size=15)

    # Sample rows
    auto_pool = ap_buckets.get("auto", [])
    sample_verified = random.sample(auto_pool, min(20, len(auto_pool)))
    fits_false = [r for r in ap_rows if r.get("review_reason") == "category_mismatch"]
    sample_fits_false = random.sample(fits_false, min(10, len(fits_false)))

    # Top review reasons
    reason_agg: dict[str, dict] = {}
    for r in ap_rows:
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

    def totals(buckets):
        return {
            "counts":  {k: len(v) for k, v in buckets.items()},
            "dollars": {k: sum_abs(v) for k, v in buckets.items()},
        }

    report = {
        "company":      {"id": cid, "name": company["name"]},
        "date_range":   inputs["date_range"],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scanned":      len(inputs["txns"]),
        "reviewed_split": inputs["reviewed_split"],
        "approved_only":  {
            **totals(ao_buckets),
            "split_by_reviewed":         split_by_reviewed(ao_rows),
            "auto_by_verification_reason": split_by_verification_reason(ao_rows),
            "llm_usage":                 approved_only["classifier"].stats.as_dict(),
        },
        "approved_plus_candidates": {
            **totals(ap_buckets),
            "split_by_reviewed":         split_by_reviewed(ap_rows),
            "auto_by_verification_reason": split_by_verification_reason(ap_rows),
            "llm_usage":                 approved_plus["classifier"].stats.as_dict(),
        },
        "top_review_reasons":       top_reasons,
        "sample_verified":          sample_verified,
        "sample_fits_false":        sample_fits_false,
        "top_llm_unsure":           top_llm_unsure_rows(ap_rows, k=10),
        "llm_unsure_cause_breakdown": unsure_cause_breakdown(ap_rows),
        "stronger_model_comparison": stronger,
        "registry_candidates_in_db": await dump_candidates(),
        "paypal_id_diagnostic": [
            {"id": k, "count": v,
             "matched_to": approved_plus["classifier"].paypal_id_matched_to.get(k, "(unmatched)")}
            for k, v in sorted(approved_plus["classifier"].paypal_id_seen.items(),
                               key=lambda kv: kv[1], reverse=True)
        ],
        "other_bank_paypal_rows":   approved_plus["classifier"].other_bank_paypal_rows[:30],
        "unpaired_transfer_candidates": approved_plus["classifier"].unpaired_transfer_candidates,
        "transfer_pair_verification":   xfer_verify,
        "shadow_diffs":     await summarize_shadow(cid),
        "shadow_summary":   {"indn": indn_sh, "normalizer": norm_sh},
        "registry_counts":  await counts_by_status(),
    }

    out_path = Path(f"/tmp/step2_report_v2_{cid}.json")
    out_path.write_text(json.dumps(report, indent=2, default=str))
    log.info("Report written to %s", out_path)

    # ---- Printed summary ----
    print("\n" + "=" * 68)
    print(f"STEP 2 REPORT v2 — {company['name']}")
    print(f"  Date range scanned: {inputs['date_range']['min']} → {inputs['date_range']['max']}")
    print(f"  Total scanned: {len(inputs['txns'])}  "
          f"(human_reviewed={inputs['reviewed_split']['human_reviewed']}, "
          f"open={inputs['reviewed_split']['open']})")
    print("=" * 68)

    def _print_pass(label, pass_dict, rows):
        print(f"\n{label}:")
        print(f"  {'bucket':<18} {'count':>6}  {'dollars':>14}")
        for k in ("auto", "always_review", "stage1", "stage2", "stage3"):
            c = pass_dict["counts"].get(k, 0)
            d = pass_dict["dollars"].get(k, 0.0)
            print(f"  {k:<18} {c:>6}  ${d:>12,.2f}")
        print(f"  auto by verification_reason:")
        for vr, s in sorted(pass_dict["auto_by_verification_reason"].items()):
            print(f"    {vr:<32}  {s['count']:>4}  ${s['dollars']:>12,.2f}")
        # Reviewed vs open split
        print(f"  split by reviewed status:")
        for stg, s in sorted(pass_dict["split_by_reviewed"].items()):
            print(f"    {stg:<16}  reviewed={s['reviewed_count']:>3}"
                  f" (${s['reviewed_dollars']:>10,.2f})  "
                  f"open={s['open_count']:>4} (${s['open_dollars']:>10,.2f})")
        print(f"  llm_usage: {pass_dict['llm_usage']}")

    _print_pass("APPROVED-ONLY", report["approved_only"], ao_rows)
    _print_pass("APPROVED + CANDIDATES", report["approved_plus_candidates"], ap_rows)

    print(f"\nTop review reasons:")
    for r in top_reasons:
        print(f"  {r['reason']:<32} {r['count']:>4}  ${r['amount']:>12,.2f}")

    print(f"\nllm_unsure cause breakdown: {report['llm_unsure_cause_breakdown']}")
    print(f"Stronger-model ({stronger['model']}) comparison — "
          f"{stronger['calls_made']} calls, ~${stronger['approx_cost_usd']}")

    print(f"\nTransfer pair verification:")
    print(f"  auto legs: {xfer_verify['total_auto_transfer_legs']}  "
          f"pairs: {xfer_verify['distinct_pairs']}  "
          f"missing partners: {xfer_verify['pairs_with_missing_partner']}")
    for pd in xfer_verify["pair_details"][:6]:
        print(f"  pair {pd['pair_id'][:12]}… ({pd['leg_count']} legs, "
              f"complete={pd['complete']}):")
        for l in pd["legs"]:
            print(f"    {l['bank_account_name']} ···{l['bank_last4'] or ''}  "
                  f"${l['amount']:>10,.2f}  {l['date']}  {l['description'][:60]}")

    print(f"\nUnpaired transfer candidates: "
          f"{len(approved_plus['classifier'].unpaired_transfer_candidates)}")
    for u in approved_plus["classifier"].unpaired_transfer_candidates[:5]:
        print(f"  {u['date']}  ${u['amount']}  acct={u['assigned_account']}  "
              f"{u['description'][:80]}")

    print(f"\nRegistry candidates in DB: {report['registry_counts'].get('candidate', 0)}")
    print(f"PayPal IDs: {len(report['paypal_id_diagnostic'])}   "
          f"Other-bank PayPal rows: {len(report['other_bank_paypal_rows'])}")
    print(f"Shadow: INDN would block={indn_sh['would_block_new_contacts']}  "
          f"NormalizerMerges={norm_sh['positive_merge_signals']}")
    print(f"\nFull JSON: {out_path}\n")


if __name__ == "__main__":
    asyncio.run(main())
