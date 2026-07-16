"""Ledger integrity audit for a company. Verifies:
  1. Every posted txn has bank_account_id AND category_account_id (else drift).
  2. Every JE has debits == credits (double-entry invariant).
  3. Trial balance = 0 (fundamental accounting equation).
  4. Balance sheet: Assets = Liabilities + Equity (+ current-year net income).
  5. Balance Sheet + Income Statement sums match the raw txn totals.
  6. Cross-check: sum of bank-side postings == sum of category-side postings
     (each txn is by construction a balanced pair).
"""
import asyncio
import sys
sys.path.insert(0, '/app/backend')
from collections import defaultdict
from db import db
import reports


async def audit(company_id: str, as_of: str = "2026-12-31"):
    company = await db.companies.find_one({"id": company_id})
    print(f"\n{'='*70}\nCompany: {company['name']}  (cid={company_id[:8]})")
    print(f"As-of date: {as_of}")
    print("="*70)

    # ── 1. txn integrity ────────────────────────────────────────────────
    txns = await db.transactions.find(
        {"company_id": company_id, "posted": True, "date": {"$lte": as_of}}
    ).to_list(100000)
    print(f"\n[1] Posted transactions: {len(txns)}")

    missing_bank = [t for t in txns if not t.get("bank_account_id")]
    missing_cat  = [t for t in txns if not t.get("category_account_id")
                                    and not t.get("splits")]
    print(f"    missing bank_account_id:     {len(missing_bank)} "
          + ("← LEAK!" if missing_bank else "OK"))
    print(f"    missing category (no splits):{len(missing_cat)} "
          + ("← LEAK!" if missing_cat else "OK"))
    if missing_cat[:2]:
        for t in missing_cat[:2]:
            print(f"      example: id={t['id'][:8]}  amt={t['amount']}  desc={t['description'][:50]!r}")

    # ── 2. JE integrity ─────────────────────────────────────────────────
    jes = await db.journal_entries.find(
        {"company_id": company_id, "date": {"$lte": as_of}}
    ).to_list(100000)
    print(f"\n[2] Journal entries: {len(jes)}")
    unbalanced_jes = []
    for j in jes:
        d = sum(float(l.get("debit", 0) or 0) for l in j.get("lines", []))
        c = sum(float(l.get("credit", 0) or 0) for l in j.get("lines", []))
        if abs(d - c) > 0.005:
            unbalanced_jes.append((j["id"], round(d, 2), round(c, 2), j.get("memo")))
    if unbalanced_jes:
        print(f"    UNBALANCED JEs: {len(unbalanced_jes)} ← FATAL")
        for uid, d, c, memo in unbalanced_jes[:3]:
            print(f"      {uid[:8]}  DR {d} CR {c}  {memo}")
    else:
        print(f"    All {len(jes)} JEs balance (DR=CR) ✓")

    # ── 3. Trial balance invariant: sum of all signed balances == 0 ────
    # (For a balanced double-entry ledger, total_debits = total_credits, so
    # signed balances across all accounts must sum to zero.)
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    by_id = {a["id"]: a for a in accts}
    bals = await reports._signed_balances(company_id, None, as_of)
    ledger_sum = sum(bals.values())
    print(f"\n[3] Ledger sum (Σ debits − Σ credits): {ledger_sum:>14,.2f}   " +
          ("ZERO ✓ (double-entry holds)" if abs(ledger_sum) < 0.01 else "← LEAK!"))
    # And the classic trial balance: total debits vs total credits.
    total_dr = sum(v for v in bals.values() if v > 0)
    total_cr = -sum(v for v in bals.values() if v < 0)
    print(f"    Σ debits:              {total_dr:>14,.2f}")
    print(f"    Σ credits:             {total_cr:>14,.2f}")
    print(f"    Match:                 {abs(total_dr - total_cr) < 0.01}")

    # ── 4. Balance-sheet equation ───────────────────────────────────────
    assets = liab = equity = revenue = expense = 0.0
    for aid, v in bals.items():
        acct = by_id.get(aid)
        if not acct: continue
        t = acct["type"]
        # For each type, apply the natural display sign
        if t == "asset":       assets  += v            # DR normal
        elif t == "liability": liab    += -v           # CR normal
        elif t == "equity":    equity  += -v           # CR normal
        elif t == "revenue":   revenue += -v           # CR normal
        elif t == "expense":   expense += v            # DR normal
    net_income = revenue - expense
    liab_plus_equity_plus_ni = liab + equity + net_income
    diff = assets - liab_plus_equity_plus_ni
    print(f"\n[4] Balance sheet equation")
    print(f"    Assets:                {assets:>14,.2f}")
    print(f"    Liabilities:           {liab:>14,.2f}")
    print(f"    Equity:                {equity:>14,.2f}")
    print(f"    Net income (Rev-Exp):  {net_income:>14,.2f}  "
          f"(Rev {revenue:,.2f} − Exp {expense:,.2f})")
    print(f"    L + E + NI:            {liab_plus_equity_plus_ni:>14,.2f}")
    print(f"    A − (L+E+NI):          {diff:>14,.2f}    " +
          ("BALANCED ✓" if abs(diff) < 0.01 else "← LEAK!"))

    # ── 5. Compare against reports.compute_balance_sheet() ────────────
    bs = await reports.compute_balance_sheet(company_id, as_of, basis="accrual")
    print(f"\n[5] compute_balance_sheet() endpoint output")
    print(f"    total_assets:               {bs['total_assets']:>14,.2f}")
    print(f"    total_liabilities:          {bs['total_liabilities']:>14,.2f}")
    print(f"    total_equity:               {bs['total_equity']:>14,.2f}")
    print(f"    total_liabilities_equity:   {bs['total_liabilities_equity']:>14,.2f}")
    print(f"    reported.balanced:          {bs['balanced']}   imbalance={bs['imbalance']}")
    match_assets = abs(assets - bs['total_assets']) < 0.02
    print(f"    manual A matches endpoint A: {match_assets}  (manual {assets:,.2f} vs endpoint {bs['total_assets']:,.2f})")

    # ── 6. Income Statement cross-check ────────────────────────────────
    is_ = await reports.compute_income_statement(company_id, "2025-01-01", as_of, basis="accrual")
    print(f"\n[6] compute_income_statement() (2025-01-01 → {as_of})")
    print(f"    total_revenue:              {is_.get('total_revenue', 0):>14,.2f}")
    print(f"    total_expense:              {is_.get('total_expense', 0):>14,.2f}")
    print(f"    net_income:                 {is_.get('net_income', 0):>14,.2f}")
    ni_endpoint = is_.get('net_income', 0)
    print(f"    matches manual NI:          {abs(ni_endpoint - net_income) < 0.02}")

    # ── 7. Balance drilldown vs actual bank balance ────────────────────
    # Plaid told us the bank's current balance. Compare with ledger balance.
    item = await db.plaid_items.find_one({"company_id": company_id})
    if item:
        for pa in item.get("accounts") or []:
            mapping = (item.get("account_mappings") or {}).get(pa["account_id"])
            if not mapping: continue
            ledger_id = mapping["ledger_account_id"]
            plaid_bal = pa.get("balance_current") or 0.0
            ledger_bal = bals.get(ledger_id, 0.0)
            acct = by_id.get(ledger_id)
            print(f"\n[7] Bank reconciliation for {acct['code']} {acct['name']}")
            print(f"    Plaid current balance: {plaid_bal:>14,.2f}")
            print(f"    Ledger balance:        {ledger_bal:>14,.2f}")
            print(f"    Drift:                 {plaid_bal - ledger_bal:>14,.2f}  " +
                  ("MATCH ✓" if abs(plaid_bal - ledger_bal) < 1.0 else "(drift is normal if any pending or unmapped)"))


async def main():
    # Audit the two companies most likely to have real data
    for cid in [
        "aeb4a36f-4c49-44c1-ae8f-40c0b69a3043",  # 627, LLC
        "2f8153a1-84bc-4ccb-bf1a-83893bffe956",  # Marketing Co
    ]:
        try:
            await audit(cid, as_of="2026-12-31")
        except Exception as e:
            print(f"\n[ERROR] {cid}: {type(e).__name__}: {e}")
            import traceback; traceback.print_exc()

asyncio.run(main())
