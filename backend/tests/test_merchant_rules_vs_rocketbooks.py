"""Regression harness for merchant_rules against the Rocketbooks CSV baseline.

The CSV at /tmp/rocketbooks.csv captures ~2363 real Plaid txns as categorized
by Rocketbooks. This test measures how many rows our deterministic rules
correctly classify BEFORE any LLM call — the single biggest lever for import
throughput and cost.

Rocketbooks-account → our-COA-code mapping (used for scoring only):
"""
import csv
import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import merchant_rules  # noqa: E402


# Rocketbooks category → our COA code mapping.
ROCKETBOOKS_TO_CODE = {
    "Entertainment Meals": "6000",
    "Meals": "6000",
    "Meals and Entertainment": "6000",
    "Utilities": "6600",
    "Gas and Electric": "6600",
    "Insurance": "6400",
    "Advertising/Promotional": "6200",
    "Dues & Subscriptions": "6250",
    "Office/General Administrative": "6300",
    "Supplies & Materials": "6800",
    "Repairs & Maintenance": "6900",
    "Transportation": "6120",
    "Automobile": "6120",
    "Bank Charges": "7000",
    "Notes Payable": "2500",
    "Credit Card": "2100",
    "Interest Earned": "4200",
    "Rent or Lease of Buildings": "6700",
    "Accounting": "6500",
    "Legal & Professional Fees": "6500",
    # Personal Expense in Rocketbooks maps to owner draw; our COA doesn't have
    # a dedicated code, so we don't score these against the rules (they'd need
    # an LLM/user judgment call anyway).
    "Personal Expense": None,
    "Other Miscellaneous Expense": None,
    # Rocketbooks buckets — same intent as our Uncategorized
    "Uncategorized Expense": None,
    "Uncategorized Income": None,
}

# Categories where our rules realistically should NOT try to match — internal
# transfers between the user's own bank accounts, Zelle, Venmo.
NON_RULE_CATEGORIES = {
    "Uncategorized Expense", "Uncategorized Income", "Checking",
    "Undeposited Funds", "Discounts given", "Accounts Receivable",
    "Commissions & fees", "Decks and Patios", "Personal Expense",
}


def _load_rows():
    path = "/tmp/rocketbooks.csv"
    if not os.path.exists(path):
        pytest.skip("Rocketbooks baseline CSV not present")
    rows = []
    with open(path, "r", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# Unit tests — spot checks
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("desc, expected_code, expected_reason_contains", [
    ("MCDONALD'S", "6000", "Fast food"),
    ("STARBUCKS STORE #1234", "6000", "Coffee"),
    ("Olive Garden", "6000", "Restaurant"),
    ("CHECKCARD 07/12 CHICK-FIL-A #123 SPARKS NV", "6000", "Fast food"),
    ("SHELL OIL 12345678", "6120", "Fuel"),
    ("COSTCO GAS", "6120", "Fuel"),
    ("AT&T PAYMENT", "6600", "telecom"),
    ("ATT DES:PAYMENT ID:XXXX", "6600", "telecom"),
    ("NV ENERGY NORTH DES:SPPC PYMT", "6600", "Electric"),
    ("NEW YORK LIFE INS. PREM.", "6400", "Life insurance"),
    ("TRUPANION DES:12345", "6400", "Pet insurance"),
    ("WALMART SUPERCENTER", "6800", "Big-box"),
    ("COSTCO WHSE #123", "6800", "Wholesale"),
    ("AMAZON.COM*ABC123", "6800", "Online retail"),
    ("HOME DEPOT #405", "6900", "Home improvement"),
    ("STAPLES 07/15", "6300", "Office"),
    ("BEST BUY 07/15", "6300", "Electronics"),
    ("NETFLIX.COM", "6250", "Streaming"),
    ("SPI*DIRECTV SERVICE", "6250", "TV subscription"),  # SPI* prefix
    ("GALAXY THEATRE LEGENDS SPARKS NV", "6250", "Entertainment subscription"),
    ("FACEBOOK ADS", "6200", "Advertising"),
    ("GUSTO PAYROLL", "7200", "Payroll"),
    ("CAPITAL ONE DES:MOBILE PMT ID:XXXX", "2100", "CC paydown"),
    ("CITI CARD ONLINE PAYMENT", "2100", "CC paydown"),
    ("ROCKET MORTGAGE LOAN", "2500", "Mortgage"),
    ("AUDI FINCL, TEL. DES:WEB DEBIT", "2500", "Auto loan"),
    ("MERCEDES-BENZ FIN PAYMENT", "2500", "Auto loan"),
    ("MONTHLY MAINTENANCE FEE", "7000", "Bank fee"),
    ("OVERDRAFT ITEM FEE", "7000", "Bank fee"),
    ("WIRE TRANSFER FEE", "7000", "Bank fee"),
    ("Interest Earned", "4200", "Interest"),  # deposit
])
def test_spot_check(desc, expected_code, expected_reason_contains):
    amount = -50.0 if expected_code not in ("4200",) else 5.0
    result = merchant_rules.rules_lookup(desc, desc, amount)
    assert result is not None, f"Expected rule match for {desc!r}"
    assert result["account_code"] == expected_code, (
        f"For {desc!r}: expected {expected_code}, got {result['account_code']} "
        f"(reason: {result.get('reasoning')})"
    )
    assert expected_reason_contains.lower() in result["reasoning"].lower()


@pytest.mark.parametrize("desc, expected_transfer", [
    ("Online Banking transfer to CHK 6278 Confirmation# XXXXX28270", True),
    ("Online Banking transfer from CHK 9917 Confirmation# XXXXX57663", True),
    ("WELLS FARGO IFI DES:DDA TO DDA ID:F20YD7QSVT", True),
    ("TRANSFER TO ACCT 1234", True),
    ("TFR FROM SAV", True),
    # Not transfers
    ("Zelle payment to Kevin Petersen Conf# xxx", False),
    ("Venmo Cashout", False),
    ("STARBUCKS", False),
    ("", False),
    (None, False),
])
def test_transfer_detection(desc, expected_transfer):
    assert merchant_rules.is_internal_transfer(desc) == expected_transfer


def test_transfer_bypasses_rules_lookup():
    """A pure internal transfer must NOT return a rules match — even if it
    contains a merchant-like string — so upstream sees a clean None and can
    route to transfer clearing."""
    r = merchant_rules.rules_lookup(
        None, "Online Banking transfer to CHK 6278 Confirmation# X1", -1000.0,
    )
    assert r is None


# ---------------------------------------------------------------------------
# Baseline: score against the Rocketbooks CSV
# ---------------------------------------------------------------------------

def test_baseline_rule_coverage_vs_rocketbooks():
    """Fail if <50% of Rocketbooks-categorized rows (excluding personal +
    uncategorized) match a rule with the correct code. Currently target: ~55%.
    """
    rows = _load_rows()

    total_scoreable = 0
    matched = 0
    correct = 0
    misses: list[tuple[str, str, str]] = []  # (desc, expected_cat, got_code)

    for r in rows:
        cat = r["account"].strip()
        if cat in NON_RULE_CATEGORIES:
            continue
        expected_code = ROCKETBOOKS_TO_CODE.get(cat)
        if not expected_code:
            continue

        total_scoreable += 1
        desc = r["description"]
        amount_raw = r.get("amount") or "0"
        try:
            amount = float(amount_raw.replace(",", ""))
        except ValueError:
            amount = 0.0
        # Withdrawal (Rocketbooks 'type' column) → negative in our convention
        if r.get("type") == "withdrawal":
            amount = -abs(amount)

        result = merchant_rules.rules_lookup(desc, desc, amount)
        if result:
            matched += 1
            if result["account_code"] == expected_code:
                correct += 1
            else:
                misses.append((desc[:60], cat, result["account_code"]))

    coverage = correct / max(1, total_scoreable)
    print(f"\n[Rocketbooks baseline]")
    print(f"  scoreable rows: {total_scoreable}")
    print(f"  rule matched:   {matched} ({matched/total_scoreable*100:.1f}%)")
    print(f"  correct code:   {correct} ({coverage*100:.1f}%)")
    if misses[:10]:
        print("  first 10 wrong-code matches:")
        for m in misses[:10]:
            print(f"    got={m[2]} expected={m[1]:30s} desc={m[0]!r}")

    # We aim for >75% deterministic match on the Rocketbooks baseline.
    # Remaining ~17% is niche merchants that hit LLM/cache fallback.
    assert coverage >= 0.75, (
        f"Rule coverage regressed: {coverage*100:.1f}% correct on scoreable rows"
    )
