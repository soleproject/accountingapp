"""
Part B — Historical Payroll JE Migration
=========================================

Sweeps every existing journal entry with `ref_kind IN ('payroll_run',
'payroll_liability_payment')` and repoints each line to the
semantically-correct payroll account for that company.

Root cause being fixed: the old `_ensure_account` matched by CoA code
first, so companies whose code `2200` was already claimed by "Sales Tax
Payable" (per common industry templates) silently had their payroll
withholdings credited to Sales Tax Payable and their gross wages
debited to whichever expense held code 6100 (Travel, etc.). See
`payroll_service._semantic_ensure_payroll_account` for the fix on new
runs; this script backfills the old ones.

Safe to run repeatedly — idempotent: a JE line whose account_id already
matches the semantically-correct account is skipped.
"""
from __future__ import annotations

import asyncio
import os
import sys
from collections import defaultdict

from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
sys.path.insert(0, "/app/backend")

from db import db, now_iso  # noqa: E402
from payroll_service import ensure_payroll_accounts  # noqa: E402


# Description → intent map for `payroll_run` JEs. Every writer path in
# `payroll_service.finalize_run` sets a stable description string.
_RUN_DESC_TO_INTENT = {
    "gross w-2 wages": "wages",
    "1099 contractor pay": "contract",
    "employer payroll taxes": "payroll_tax",
    "employer benefit contributions": "benefits",
    "withheld + employer payroll liabilities": "liab",
    "employee voluntary deductions": "ded",
    # "Net pay disbursed" intentionally omitted — this line points at
    # the actual bank account chosen by the user at finalize time and
    # must never be repointed.
}


def _intent_for_run_line(line: dict) -> str | None:
    desc = (line.get("description") or "").strip().lower()
    return _RUN_DESC_TO_INTENT.get(desc)


async def _migrate_payroll_run_je(je: dict, correct: dict) -> tuple[int, list[str]]:
    """Return (patched_count, notes)."""
    patches: list[dict] = []
    notes: list[str] = []
    for i, l in enumerate(je.get("lines") or []):
        intent = _intent_for_run_line(l)
        if intent is None:
            continue  # bank line or unrecognized — leave alone
        target = correct[intent]
        cur_aid = l.get("account_id")
        if cur_aid == target["id"]:
            continue
        patches.append({
            "index": i,
            "old_account_id": cur_aid,
            "new_account_id": target["id"],
            "new_account_name": target["name"],
            "intent": intent,
            "amount": l.get("debit") or l.get("credit") or 0,
        })
    if not patches:
        return 0, notes
    # Apply patches inline on a copy of the lines array.
    new_lines = list(je["lines"])
    for p in patches:
        new_lines[p["index"]] = {
            **new_lines[p["index"]],
            "account_id": p["new_account_id"],
            "account_name": p["new_account_name"],
        }
        notes.append(
            f"  line[{p['index']}] {p['intent']:<12} ${p['amount']:>8.2f}"
            f" — was {p['old_account_id']} → {p['new_account_id']}"
            f" ({p['new_account_name']})"
        )
    await db.journal_entries.update_one(
        {"id": je["id"]},
        {"$set": {"lines": new_lines, "updated_at": now_iso()}},
    )
    return len(patches), notes


async def _migrate_pay_liability_je(je: dict, correct: dict) -> tuple[int, list[str]]:
    """Repoint DR side of a payroll_liability_payment JE.

    The CR line is the bank (leave alone). The DR side has one or two
    lines: (a) Payroll Liabilities (ee_tax + er_tax + er_ben), and
    optionally (b) Payroll Deductions Payable (ee_ded). We identify
    which is which by cross-referencing the `payroll_liability_payments`
    doc that shares the same JE via `je_id`.
    """
    plp = await db.payroll_liability_payments.find_one(
        {"company_id": je["company_id"], "je_id": je["id"]}
    )
    if not plp:
        # Older payments may not have `je_id` stamped — fall back to
        # description string ("Payroll tax remittance"/"Employee
        # deduction remittance") for a best-effort match.
        return await _migrate_pay_liability_by_desc(je, correct)

    liab_amt = round(
        float(plp.get("ee_tax") or 0)
        + float(plp.get("er_tax") or 0)
        + float(plp.get("er_ben") or 0),
        2,
    )
    ded_amt = round(float(plp.get("ee_ded") or 0), 2)

    patches: list[dict] = []
    notes: list[str] = []
    for i, l in enumerate(je.get("lines") or []):
        d = round(float(l.get("debit") or 0), 2)
        if d <= 0:
            continue  # CR bank line
        if liab_amt > 0 and abs(d - liab_amt) < 0.005:
            intent = "liab"
        elif ded_amt > 0 and abs(d - ded_amt) < 0.005:
            intent = "ded"
        else:
            # Amount doesn't match either — most likely a merged single
            # line ($liab+$ded) or corrupted numbers. Fall back to desc.
            desc = (l.get("description") or "").lower()
            if "deduction" in desc:
                intent = "ded"
            else:
                intent = "liab"
        target = correct[intent]
        if l.get("account_id") == target["id"]:
            continue
        patches.append({
            "index": i, "intent": intent, "amount": d,
            "old_account_id": l.get("account_id"),
            "new_account_id": target["id"],
            "new_account_name": target["name"],
        })
    if not patches:
        return 0, notes
    new_lines = list(je["lines"])
    for p in patches:
        new_lines[p["index"]] = {
            **new_lines[p["index"]],
            "account_id": p["new_account_id"],
            "account_name": p["new_account_name"],
        }
        notes.append(
            f"  line[{p['index']}] {p['intent']:<12} ${p['amount']:>8.2f}"
            f" — was {p['old_account_id']} → {p['new_account_id']}"
            f" ({p['new_account_name']})"
        )
    await db.journal_entries.update_one(
        {"id": je["id"]},
        {"$set": {"lines": new_lines, "updated_at": now_iso()}},
    )
    return len(patches), notes


async def _migrate_pay_liability_by_desc(je: dict, correct: dict) -> tuple[int, list[str]]:
    """Fallback path when we can't find the paired payment doc."""
    patches: list[dict] = []
    notes: list[str] = []
    for i, l in enumerate(je.get("lines") or []):
        if (l.get("debit") or 0) <= 0:
            continue
        desc = (l.get("description") or "").lower()
        intent = "ded" if "deduction" in desc else "liab"
        target = correct[intent]
        if l.get("account_id") == target["id"]:
            continue
        patches.append({
            "index": i, "intent": intent,
            "amount": float(l.get("debit") or 0),
            "old_account_id": l.get("account_id"),
            "new_account_id": target["id"],
            "new_account_name": target["name"],
        })
    if not patches:
        return 0, notes
    new_lines = list(je["lines"])
    for p in patches:
        new_lines[p["index"]] = {
            **new_lines[p["index"]],
            "account_id": p["new_account_id"],
            "account_name": p["new_account_name"],
        }
        notes.append(
            f"  line[{p['index']}] {p['intent']:<12} ${p['amount']:>8.2f}"
            f" [desc-fallback] — was {p['old_account_id']} → {p['new_account_id']}"
        )
    await db.journal_entries.update_one(
        {"id": je["id"]},
        {"$set": {"lines": new_lines, "updated_at": now_iso()}},
    )
    return len(patches), notes


async def main(dry_run: bool = False) -> None:
    print("=" * 72)
    print(f"PAYROLL JE MIGRATION  {'(DRY RUN)' if dry_run else '(LIVE)'}")
    print("=" * 72)

    # Bucket all payroll JEs by company for efficient processing.
    by_cid: dict[str, list[dict]] = defaultdict(list)
    async for je in db.journal_entries.find(
        {"ref_kind": {"$in": ["payroll_run", "payroll_liability_payment"]}}
    ):
        by_cid[je["company_id"]].append(je)

    total_jes = 0
    total_patched = 0
    total_lines_patched = 0

    for cid, jes in by_cid.items():
        comp = await db.companies.find_one({"id": cid}, {"name": 1})
        cname = comp.get("name") if comp else "??"
        print(f"\n▸ {cname}  ({cid})  · {len(jes)} payroll JE(s)")

        # Resolve the semantically-correct accounts for this company.
        # This uses the fixed resolver so it will CREATE new accounts
        # (with all correct fields) if none exist — the very same
        # accounts new payroll runs will use going forward.
        correct = await ensure_payroll_accounts(cid)
        for k, a in correct.items():
            print(f"    {k:<12} → code={a['code']:<6} {a['name']}")

        for je in jes:
            total_jes += 1
            if je.get("ref_kind") == "payroll_run":
                n, notes = await _migrate_payroll_run_je(je, correct)
            else:
                n, notes = await _migrate_pay_liability_je(je, correct)
            if n > 0:
                total_patched += 1
                total_lines_patched += n
                print(f"    JE {je['id'][:8]}… ({je.get('date')}) — patched {n} line(s):")
                for nt in notes:
                    print(nt)

    print()
    print("=" * 72)
    print(f"DONE — companies={len(by_cid)}  JEs scanned={total_jes}  "
          f"JEs patched={total_patched}  lines patched={total_lines_patched}")
    print("=" * 72)


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    asyncio.run(main(dry_run=dry))
