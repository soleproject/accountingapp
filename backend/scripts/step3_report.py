"""Step 3 report — Cards + Grouping + Adjustments per user spec.

Produces the deliverables from the user's Step 3 message:

  1. Question count (cards) per stage + avg rows/card + top-10 cards
  2. Candidate impact: which candidates/types pushed rows into always_review
  3. Single-purpose auto stats (before vs after) + 20-row sample
  4. Wire routing counts
  5. LLM stronger-model fallback stats
  6. Grouping into cards:
       - stage1: 1 card per destination account (unpaired transfers) +
                 1 per card account (credit_card_payment)
       - stage2: 1 card per (contact, direction)
  7. Category-mismatch 20-row sample with suggested_category
  8. Full PayPal ID list + all other-bank formats
  9. 104 candidates as bulk-approve table
 10. Full-history bucket counts split by reviewed vs open
"""
from __future__ import annotations
import asyncio
import json
import logging
import random
import re
import statistics as _stats
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/app/backend")

from db import db
from brand_registry import (
    ensure_indexes as _br_ensure,
    seed_admin_defaults as _br_seed,
    counts_by_status,
    _norm as _brand_norm,
)
from brand_llm import BrandLLMStats
from paypal_parser import has_indn, extract_indn
from name_normalizer_v2 import merge_signal
from shadow_log import log_diff, summarize as summarize_shadow
from reviewv2_step2 import Step2Classifier, get_settings, _canonical_from_txn

log = logging.getLogger("axiom.step3_report")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

TEST_COMPANY_NAME = "Test 519 LLC"
STRONGER_MODEL = "gpt-4o"

# --------------------------------------------------------------- utilities

_CHK_RX = re.compile(r"CHK\s*(\d{4,6})", re.IGNORECASE)
_CARD_LAST4_RX = re.compile(r"\b(\d{4})\b\s*$")


def _dest_account_key(desc: str | None) -> str:
    """Extract "CHK 6278" -> '6278' as the grouping key for stage1
    unpaired-transfer cards. Falls back to '(unknown)'."""
    m = _CHK_RX.search(desc or "")
    if m:
        return f"CHK ···{m.group(1)}"
    d = (desc or "").strip()
    return d[:60] if d else "(unknown)"


async def _contact_name_map(cid: str) -> dict[str, str]:
    out: dict[str, str] = {}
    async for c in db.contacts.find({"company_id": cid}, {"id": 1, "name": 1}):
        if c.get("id"):
            out[c["id"]] = c.get("name") or "(unnamed)"
    return out


def _label_card(c: dict, contact_names: dict[str, str]) -> str:
    """Human-readable label for a card (contact NAME not id).
    Special-cases contact_direction so stage2 shows 'Kevin Petersen · out'."""
    if c["kind"] == "contact_direction":
        contact_id, _, direction = c["key"].partition("::")
        nm = contact_names.get(contact_id, contact_id[:8] + "…")
        return f"{nm} · {direction}"
    return str(c["key"])


def stage3_topN_by_dollars(rows, n=10):
    s3 = [r for r in rows if r["stage"] == "stage3"]
    s3.sort(key=lambda r: abs(float(r.get("amount") or 0)), reverse=True)
    return [{
        "id":            r.get("id"),
        "date":          r.get("date"),
        "amount":        r.get("amount"),
        "description":   (r.get("description") or "")[:180],
        "merchant":      r.get("merchant"),
        "review_reason": r.get("review_reason"),
        "wire_direction": r.get("extras", {}).get("wire_direction"),
    } for r in s3[:n]]


def sum_abs(rows):
    return round(sum(abs(float(r.get("amount") or 0)) for r in rows), 2)


# --------------------------------------------------------------- pipeline

async def clear_stale_state() -> None:
    """Delete previous candidates + LLM cache so we run against the new
    prompt + new classifier logic. Approved seeds stay."""
    c1 = await db.brand_registry.delete_many({"status": "candidate"})
    c2 = await db.brand_llm_cache.delete_many({})
    log.info("Cleared %d candidates, %d cached LLM results",
             c1.deleted_count, c2.deleted_count)


async def load_inputs(cid: str) -> dict:
    from routes.reviewv2 import _load_connected_account_ids, _is_connected_asset
    accts_by_id = {a["id"]: a async for a in db.accounts.find({"company_id": cid})}
    connected_ids = await _load_connected_account_ids(cid)
    for aid, a in accts_by_id.items():
        if _is_connected_asset(a):
            connected_ids.add(aid)
    txns = [t async for t in db.transactions.find({"company_id": cid}).limit(5000)]

    medians_raw: dict[str, list[float]] = {}
    for t in txns:
        canon = _canonical_from_txn(t)
        if canon:
            medians_raw.setdefault(_brand_norm(canon), []).append(
                abs(float(t.get("amount") or 0))
            )
    medians = {k: _stats.median(v) for k, v in medians_raw.items() if len(v) >= 3}

    transfer_pair_map: dict[str, list[dict]] = {}
    for t in txns:
        pid = t.get("transfer_pair_id")
        if pid:
            transfer_pair_map.setdefault(pid, []).append(t)

    approved_sample = [
        r["canonical_name"] async for r in db.brand_registry
        .find({"status": "approved"}, {"canonical_name": 1}).limit(120)
    ]
    dates = [t.get("date") for t in txns if t.get("date")]
    return {
        "accts_by_id":       accts_by_id,
        "connected_ids":     connected_ids,
        "txns":              txns,
        "medians":           medians,
        "transfer_pair_map": transfer_pair_map,
        "approved_sample":   approved_sample,
        "date_range":        {"min": min(dates) if dates else None,
                              "max": max(dates) if dates else None},
        "reviewed_split":    {
            "human_reviewed": sum(1 for t in txns if t.get("human_reviewed")),
            "open":           sum(1 for t in txns if not t.get("human_reviewed")),
        },
    }


async def run_classifier(cid: str, inputs: dict, include_candidates: bool) -> dict:
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
    rows = []
    for t in inputs["txns"]:
        rows.append(await cls.classify(t, transfer_pair_map=inputs["transfer_pair_map"]))
    return {"classifier": cls, "rows": rows}


# --------------------------------------------------------------- card grouping

def build_cards(rows: list[dict]) -> dict:
    """Group review rows into client-facing CARDS.

      • stage1
          - unpaired_transfer_candidate → 1 card per destination account
          - credit_card_payment         → 1 card per card_key
          - orphan_transfer_leg         → 1 card per leg (singleton)
      • stage2
          - one card per (contact_id, direction)
      • stage3
          - wire_needs_counterparty     → 1 card per direction+amount bucket
          - payment_app_no_counterparty → 1 card per row
          - everything else             → 1 card per row
      • always_review
          - category_mismatch, over_threshold, sensitive_merchant_type
            → 1 card per (merchant canonical_name, reason)
    """
    cards: list[dict] = []

    def _push(stage, kind, key, rows_group, extra=None):
        cards.append({
            "stage":    stage,
            "kind":     kind,
            "key":      key,
            "row_count": len(rows_group),
            "amount":   sum_abs(rows_group),
            "rows":     rows_group,
            "extras":   extra or {},
        })

    # ---- STAGE 1 groupings ----
    stage1 = [r for r in rows if r["stage"] == "stage1"]
    unpaired = [r for r in stage1 if r.get("review_reason") == "unpaired_transfer_candidate"]
    by_dest: dict[str, list[dict]] = defaultdict(list)
    for r in unpaired:
        by_dest[_dest_account_key(r.get("description"))].append(r)
    for k, grp in by_dest.items():
        _push("stage1", "unpaired_transfer_group", k, grp,
              extra={"question": f"Is account {k} yours?"})

    credit_pmts = [r for r in stage1 if r.get("review_reason") == "credit_card_payment"]
    by_card: dict[str, list[dict]] = defaultdict(list)
    for r in credit_pmts:
        key = (r.get("extras", {}).get("card_key")
               or (r.get("merchant_match") or {}).get("canonical_name")
               or "unknown_card")
        by_card[key].append(r)
    for k, grp in by_card.items():
        _push("stage1", "credit_card_group", k, grp,
              extra={"question": f"Is your {k} account used for the business?"})

    orphans = [r for r in stage1 if r.get("review_reason") == "orphan_transfer_leg"]
    for r in orphans:
        _push("stage1", "orphan_transfer_leg", r.get("id"), [r])

    # ---- STAGE 2 groupings ----
    stage2 = [r for r in rows if r["stage"] == "stage2"]
    by_ck: dict[tuple, list[dict]] = defaultdict(list)
    for r in stage2:
        ck = (r.get("contact_id") or "(no contact)",
              "in" if (r.get("amount") or 0) > 0 else "out")
        by_ck[ck].append(r)
    for (contact_id, direction), grp in by_ck.items():
        _push("stage2", "contact_direction",
              f"{contact_id}::{direction}", grp,
              extra={"direction": direction, "contact_id": contact_id})

    # ---- STAGE 3 groupings ----
    stage3 = [r for r in rows if r["stage"] == "stage3"]
    wires = [r for r in stage3 if r.get("review_reason") == "wire_needs_counterparty"]
    for r in wires:  # each wire is per-txn (unique amount + date)
        wd = r.get("extras", {}).get("wire_direction") or "?"
        _push("stage3", "wire", f"{wd}:{r.get('id')}", [r],
              extra={"direction": wd,
                     "question": r.get("extras", {}).get("stage3_question")})
    other3 = [r for r in stage3 if r.get("review_reason") != "wire_needs_counterparty"]
    for r in other3:
        _push("stage3", r.get("review_reason") or "singleton",
              r.get("id"), [r])

    # ---- ALWAYS_REVIEW groupings ----
    ar = [r for r in rows if r["stage"] == "always_review"]
    by_mr: dict[tuple, list[dict]] = defaultdict(list)
    for r in ar:
        key = ((r.get("merchant_match") or {}).get("canonical_name")
               or r.get("merchant") or "(unknown)",
               r.get("review_reason") or "unknown")
        by_mr[key].append(r)
    for (merchant, reason), grp in by_mr.items():
        _push("always_review", "merchant_reason",
              f"{merchant}::{reason}", grp,
              extra={"merchant": merchant, "reason": reason})

    # ---- Summary ----
    by_stage: dict[str, list[dict]] = defaultdict(list)
    for c in cards:
        by_stage[c["stage"]].append(c)

    summary = {}
    for stg, lst in by_stage.items():
        summary[stg] = {
            "cards":         len(lst),
            "rows":          sum(c["row_count"] for c in lst),
            "avg_rows_per_card": round(
                sum(c["row_count"] for c in lst) / max(len(lst), 1), 2
            ),
            "dollars":       round(sum(c["amount"] for c in lst), 2),
        }

    largest = sorted(cards, key=lambda c: c["row_count"], reverse=True)[:10]
    largest_by_dollar = sorted(cards, key=lambda c: c["amount"], reverse=True)[:10]
    return {
        "summary":         summary,
        "cards":           cards,
        "top_by_rows":     [
            {"stage": c["stage"], "kind": c["kind"], "key": c["key"],
             "row_count": c["row_count"], "amount": c["amount"],
             "extras": c["extras"]}
            for c in largest
        ],
        "top_by_dollars":  [
            {"stage": c["stage"], "kind": c["kind"], "key": c["key"],
             "row_count": c["row_count"], "amount": c["amount"],
             "extras": c["extras"]}
            for c in largest_by_dollar
        ],
    }


# --------------------------------------------------------------- misc reports

async def candidate_impact(rows_approved_only: list[dict],
                            rows_with_candidates: list[dict]) -> dict:
    """The user asked "which candidates / merchant_types drove ~223
    rows into always_review when we include candidates". Compare the
    stage of every txn between the two passes; count moves BY the
    candidate that caused it (found from the with-candidates row's
    merchant_match)."""
    by_id_ao = {r["id"]: r for r in rows_approved_only}
    moves_to_ar: list[dict] = []
    for r in rows_with_candidates:
        ao = by_id_ao.get(r["id"])
        if not ao:
            continue
        if r["stage"] == "always_review" and ao["stage"] != "always_review":
            mm = r.get("merchant_match") or {}
            moves_to_ar.append({
                "id":            r.get("id"),
                "amount":        r.get("amount"),
                "canonical":     mm.get("canonical_name"),
                "merchant_type": mm.get("merchant_type"),
                "review_reason": r.get("review_reason"),
                "from_stage":    ao["stage"],
            })
    by_canon: dict[str, dict] = {}
    by_type: dict[str, dict] = {}
    by_reason: dict[str, dict] = {}
    for m in moves_to_ar:
        for tallies, k in ((by_canon, m["canonical"] or "(none)"),
                           (by_type,  m["merchant_type"] or "(none)"),
                           (by_reason, m["review_reason"] or "(none)")):
            s = tallies.setdefault(k, {"count": 0, "amount": 0.0})
            s["count"] += 1
            s["amount"] += abs(float(m.get("amount") or 0))
    def _fmt(d):
        return sorted(
            [{"key": k, "count": v["count"], "amount": round(v["amount"], 2)}
             for k, v in d.items()],
            key=lambda x: x["count"], reverse=True,
        )
    return {
        "total_moves_to_always_review": len(moves_to_ar),
        "by_canonical":                 _fmt(by_canon)[:30],
        "by_merchant_type":             _fmt(by_type),
        "by_review_reason":             _fmt(by_reason),
        "sample_moves":                 moves_to_ar[:25],
    }


async def candidates_bulk_table(rows: list[dict]) -> list[dict]:
    """Table of every candidate + row counts + $ from the current run."""
    per_canon: dict[str, dict] = {}
    for r in rows:
        mm = r.get("merchant_match") or {}
        if mm.get("status") != "candidate":
            continue
        k = mm.get("canonical_name") or "(unknown)"
        s = per_canon.setdefault(k, {"count": 0, "amount": 0.0})
        s["count"] += 1
        s["amount"] += abs(float(r.get("amount") or 0))
    # Merge with the DB rows so a candidate the LLM proposed but
    # matched zero rows this pass still shows up in the table.
    out = []
    async for c in db.brand_registry.find({"status": "candidate"}).sort("canonical_name", 1):
        canon = c.get("canonical_name")
        stats = per_canon.pop(canon, {"count": 0, "amount": 0.0})
        out.append({
            "canonical_name": canon,
            "merchant_type":  c.get("merchant_type"),
            "category_hint":  c.get("category_hint"),
            "personal_risk":  c.get("personal_risk", False),
            "row_count":      stats["count"],
            "amount":         round(stats["amount"], 2),
            "llm_reason":     (c.get("llm_reason") or "")[:120],
        })
    return sorted(out, key=lambda r: r["amount"], reverse=True)


def category_mismatch_sample(rows: list[dict], n: int = 20) -> list[dict]:
    mismatches = [r for r in rows if r.get("review_reason") == "category_mismatch"]
    sample = random.sample(mismatches, min(n, len(mismatches))) if mismatches else []
    out = []
    for r in sample:
        fit = r.get("extras", {}).get("category_fits") or {}
        out.append({
            "id":         r.get("id"),
            "date":       r.get("date"),
            "amount":     r.get("amount"),
            "merchant":   r.get("merchant") or (r.get("merchant_match") or {}).get("canonical_name"),
            "current_account":    r.get("assigned_account"),
            "suggested_category": r.get("extras", {}).get("suggested_category")
                                  or fit.get("suggested_category"),
            "reason":     fit.get("reason"),
        })
    return out


def single_purpose_sample(rows: list[dict], n: int = 20) -> list[dict]:
    """Return a random n-sample of the newly auto-handled
    single-purpose rows so the CPA can spot-check."""
    sp = [r for r in rows if r.get("verification_reason") == "single_purpose_category_fits"]
    return random.sample(sp, min(n, len(sp))) if sp else []


def paypal_diagnostic(cls: Step2Classifier) -> list[dict]:
    return [
        {"id": k, "count": v,
         "matched_to": cls.paypal_id_matched_to.get(k, "(unmatched)")}
        for k, v in sorted(cls.paypal_id_seen.items(),
                           key=lambda kv: kv[1], reverse=True)
    ]


def top_llm_unsure(rows: list[dict], k: int = 10) -> list[dict]:
    unsure = [r for r in rows if r.get("review_reason") == "llm_unsure"]
    unsure.sort(key=lambda r: abs(float(r.get("amount") or 0)), reverse=True)
    return [{
        "id": r.get("id"), "date": r.get("date"),
        "amount": r.get("amount"),
        "descriptor": (r.get("description") or "")[:180],
        "merchant":   r.get("merchant"),
        "llm_result": r.get("extras", {}).get("llm_result"),
    } for r in unsure[:k]]


def split_by_reviewed(rows):
    out: dict[str, dict] = {}
    for r in rows:
        s = r["stage"]
        slot = out.setdefault(s, {"reviewed": 0, "open": 0,
                                   "reviewed_$": 0.0, "open_$": 0.0})
        amt = abs(float(r.get("amount") or 0))
        if r.get("human_reviewed"):
            slot["reviewed"] += 1
            slot["reviewed_$"] += amt
        else:
            slot["open"] += 1
            slot["open_$"] += amt
    for v in out.values():
        v["reviewed_$"] = round(v["reviewed_$"], 2)
        v["open_$"] = round(v["open_$"], 2)
    return out


def auto_by_verification_reason(rows):
    out: dict[str, dict] = {}
    for r in rows:
        if r["stage"] != "auto":
            continue
        vr = r.get("verification_reason") or "unknown"
        s = out.setdefault(vr, {"count": 0, "$": 0.0})
        s["count"] += 1
        s["$"] += abs(float(r.get("amount") or 0))
    for v in out.values():
        v["$"] = round(v["$"], 2)
    return out


# --------------------------------------------------------------- main

async def main():
    await _br_ensure()
    await _br_seed()
    company = await db.companies.find_one({"name": TEST_COMPANY_NAME})
    if not company:
        raise SystemExit("Test 519 LLC not found.")
    cid = company["id"]
    log.info("Test company: %s", cid)

    # Feature flag on (idempotent).
    await db.companies.update_one(
        {"id": cid}, {"$set": {"features.brand_registry_v2": True}}
    )
    await clear_stale_state()

    inputs = await load_inputs(cid)
    log.info("Scanning %d txns %s → %s (reviewed=%d open=%d)",
             len(inputs["txns"]),
             inputs["date_range"]["min"], inputs["date_range"]["max"],
             inputs["reviewed_split"]["human_reviewed"],
             inputs["reviewed_split"]["open"])

    log.info("Pass 1: approved-only …")
    p_ao = await run_classifier(cid, inputs, include_candidates=False)
    log.info("Pass 2: approved + candidates …")
    p_ap = await run_classifier(cid, inputs, include_candidates=True)

    ao_rows = p_ao["rows"]
    ap_rows = p_ap["rows"]

    # Stronger-model fallback on approved+candidates pass
    log.info("Stronger-model (gpt-4o) fallback pass over llm_unsure …")
    retry = await p_ap["classifier"].retry_llm_unsure_with_stronger_model(
        list(zip(ap_rows, inputs["txns"])),
        transfer_pair_map=inputs["transfer_pair_map"],
        stronger_model=STRONGER_MODEL,
    )
    # Apply updated rows in-place
    for idx, new_row in retry["updated_rows"]:
        ap_rows[idx] = new_row
    log.info("Stronger-model resolved %d of %d attempted",
             retry["resolved"], retry["attempted"])

    def bucketed(rows):
        b = {"auto": [], "always_review": [], "stage1": [], "stage2": [], "stage3": []}
        for r in rows:
            b.setdefault(r["stage"], []).append(r)
        return b

    ao_b = bucketed(ao_rows)
    ap_b = bucketed(ap_rows)
    counts = lambda b: {k: len(v) for k, v in b.items()}
    dollars = lambda b: {k: sum_abs(v) for k, v in b.items()}

    # Cards
    cards_ap = build_cards(ap_rows)
    # Enrich card summary with contact names
    contact_names = await _contact_name_map(cid)
    for group in ("top_by_rows", "top_by_dollars"):
        for c in cards_ap[group]:
            c["label"] = _label_card(c, contact_names)

    # Stage 3 top by dollars (per user's #6 ask)
    stage3_top = stage3_topN_by_dollars(ap_rows, 10)

    # Candidate impact
    cand_impact = await candidate_impact(ao_rows, ap_rows)

    # Category mismatch sample (with suggested_category)
    cat_mm_sample = category_mismatch_sample(ap_rows, 20)

    # Single-purpose auto sample
    sp_sample = single_purpose_sample(ap_rows, 20)

    # Candidates bulk-approve table
    cand_table = await candidates_bulk_table(ap_rows)

    # Auto random sample
    auto_pool = [r for r in ap_rows if r["stage"] == "auto"]
    sample_verified = random.sample(auto_pool, min(20, len(auto_pool))) if auto_pool else []

    # Top review reasons
    reason_agg: dict[str, dict] = {}
    for r in ap_rows:
        rr = r.get("review_reason")
        if not rr:
            continue
        s = reason_agg.setdefault(rr, {"count": 0, "$": 0.0})
        s["count"] += 1
        s["$"] += abs(float(r.get("amount") or 0))
    top_reasons = sorted(
        [{"reason": k, "count": v["count"], "amount": round(v["$"], 2)}
         for k, v in reason_agg.items()],
        key=lambda x: x["count"], reverse=True,
    )[:12]

    # PayPal diagnostic — from the approved+candidates classifier
    paypal_ids = paypal_diagnostic(p_ap["classifier"])
    other_bank = p_ap["classifier"].other_bank_paypal_rows[:30]

    # Wire counts
    wires = [r for r in ap_rows if r.get("review_reason") == "wire_needs_counterparty"]
    wire_in = sum(1 for r in wires if r.get("extras", {}).get("wire_direction") == "in")
    wire_out = sum(1 for r in wires if r.get("extras", {}).get("wire_direction") == "out")

    report = {
        "company":      {"id": cid, "name": company["name"]},
        "date_range":   inputs["date_range"],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scanned":      len(inputs["txns"]),
        "reviewed_split": inputs["reviewed_split"],
        "approved_only": {
            "counts":  counts(ao_b),
            "dollars": dollars(ao_b),
            "split_by_reviewed": split_by_reviewed(ao_rows),
            "auto_by_verification_reason": auto_by_verification_reason(ao_rows),
            "llm_usage": p_ao["classifier"].stats.as_dict(),
        },
        "approved_plus_candidates": {
            "counts":  counts(ap_b),
            "dollars": dollars(ap_b),
            "split_by_reviewed": split_by_reviewed(ap_rows),
            "auto_by_verification_reason": auto_by_verification_reason(ap_rows),
            "llm_usage": p_ap["classifier"].stats.as_dict(),
        },
        "top_review_reasons":       top_reasons,
        "sample_verified":          sample_verified,
        "cards":                    cards_ap,
        "stage3_top_by_dollars":    stage3_top,
        "wire_counts":              {"in": wire_in, "out": wire_out, "total": len(wires)},
        "stronger_model_fallback":  {
            "attempted":    retry["attempted"],
            "resolved":     retry["resolved"],
            "still_unsure": retry["still_unsure"],
            "by_new_stage": retry["by_new_stage"],
            "model":        retry["model"],
            "stats":        retry["stats"],
        },
        "candidate_impact":         cand_impact,
        "category_mismatch_sample": cat_mm_sample,
        "single_purpose_sample":    sp_sample,
        "candidates_bulk_table":    cand_table,
        "paypal_id_diagnostic":     paypal_ids,
        "other_bank_paypal_rows":   other_bank,
        "top_llm_unsure":           top_llm_unsure(ap_rows, 10),
        "registry_counts":          await counts_by_status(),
    }

    out_path = Path(f"/tmp/step3_report_{cid}.json")
    out_path.write_text(json.dumps(report, indent=2, default=str))
    log.info("Report written to %s", out_path)

    # ---- Printed summary ----
    print("\n" + "=" * 72)
    print(f"STEP 3 REPORT — {company['name']}")
    print(f"  {inputs['date_range']['min']} → {inputs['date_range']['max']}   "
          f"scanned={len(inputs['txns'])}  reviewed=1  open={inputs['reviewed_split']['open']}")
    print("=" * 72)

    def _print_pass(label, block):
        print(f"\n{label}:")
        for k in ("auto", "always_review", "stage1", "stage2", "stage3"):
            print(f"  {k:<16} {block['counts'].get(k, 0):>5}  "
                  f"${block['dollars'].get(k, 0.0):>12,.2f}")
        print("  auto by verification_reason:")
        for vr, s in sorted(block["auto_by_verification_reason"].items()):
            print(f"    {vr:<34}  {s['count']:>5}  ${s['$']:>12,.2f}")
        print(f"  llm_usage: {block['llm_usage']}")

    _print_pass("APPROVED-ONLY", report["approved_only"])
    _print_pass("APPROVED + CANDIDATES  (post stronger-model retry)",
                report["approved_plus_candidates"])

    print("\nCARDS (client-facing questions):")
    for stg, s in cards_ap["summary"].items():
        print(f"  {stg:<16} cards={s['cards']:>5} rows={s['rows']:>5} "
              f"avg/card={s['avg_rows_per_card']:>4}  ${s['dollars']:>12,.2f}")
    print("\n  Top 10 cards by rows:")
    for c in cards_ap["top_by_rows"]:
        print(f"    {c['stage']:<14} {c['kind']:<24} "
              f"{c.get('label') or c['key']:<40}  rows={c['row_count']:>4} ${c['amount']:>10,.2f}")
    print("  Top 10 cards by dollars:")
    for c in cards_ap["top_by_dollars"]:
        print(f"    {c['stage']:<14} {c['kind']:<24} "
              f"{c.get('label') or c['key']:<40}  rows={c['row_count']:>4} ${c['amount']:>10,.2f}")

    print(f"\nSTAGE 3 top 10 by $ (explains the ${sum(abs(float(r.get('amount') or 0)) for r in ap_rows if r['stage']=='stage3'):,.2f} bucket):")
    for r in stage3_top:
        wire_tag = f" [{r['wire_direction'] or '?'}]" if r["review_reason"] == "wire_needs_counterparty" else ""
        print(f"  ${r['amount']:>12,.2f}  {r['date']}  {r['review_reason']}{wire_tag}")
        print(f"      {r['description'][:120]}")

    print(f"\nStronger-model fallback: attempted={retry['attempted']} "
          f"resolved={retry['resolved']} still_unsure={retry['still_unsure']}   "
          f"cost≈${retry['stats']['approx_cost_usd']}")
    if retry["by_new_stage"]:
        print(f"  Newly-classified stages: {retry['by_new_stage']}")

    print(f"\nWires: in={wire_in} out={wire_out} → all stage3, review_reason=wire_needs_counterparty")

    print(f"\nCandidate impact — {cand_impact['total_moves_to_always_review']} rows moved into always_review by adding candidates:")
    print("  by merchant_type:")
    for row in cand_impact["by_merchant_type"]:
        print(f"    {row['key']:<20} {row['count']:>4}  ${row['amount']:>10,.2f}")
    print("  by review_reason:")
    for row in cand_impact["by_review_reason"]:
        print(f"    {row['key']:<26} {row['count']:>4}  ${row['amount']:>10,.2f}")
    print("  top 10 canonicals moved:")
    for row in cand_impact["by_canonical"][:10]:
        print(f"    {row['key']:<28} {row['count']:>4}  ${row['amount']:>10,.2f}")

    sp_hit = auto_by_verification_reason(ap_rows).get(
        "single_purpose_category_fits", {"count": 0, "$": 0.0})
    print(f"\nLocal single-purpose auto-handle: "
          f"{sp_hit['count']} rows / ${sp_hit['$']:,.2f}  "
          f"(sample size {len(sp_sample)} in report)")

    print(f"\nPayPal IDs seen (full history): {len(paypal_ids)} distinct")
    for p in paypal_ids:
        print(f"  ID='{p['id']}'  count={p['count']}  matched_to={p['matched_to']}")
    print(f"Other-bank PayPal rows: {len(other_bank)}")
    for r in other_bank[:6]:
        print(f"  {r['date']}  ${r['amount']}  {r['description'][:120]}")

    print(f"\nCandidates in DB (bulk-approve table): {len(cand_table)}")
    print(f"  Top 15 by $:")
    for c in cand_table[:15]:
        pr = "PR" if c["personal_risk"] else "  "
        print(f"    [{pr}] {c['canonical_name']:<32} {c['merchant_type']:<15} "
              f"rows={c['row_count']:>4}  ${c['amount']:>10,.2f}  hint={c['category_hint']}")

    print(f"\nCategory-mismatch sample ({len(cat_mm_sample)} rows w/ suggested_category):")
    for r in cat_mm_sample[:10]:
        print(f"  ${r['amount']:>10,.2f}  {r['merchant']:<30}  "
              f"current={r['current_account']}  suggest={r['suggested_category']}")
        print(f"    reason: {(r['reason'] or '')[:120]}")

    print(f"\nFull JSON: {out_path}\n")


if __name__ == "__main__":
    asyncio.run(main())
