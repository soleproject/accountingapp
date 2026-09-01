"""Global vendor rules — sign-aware routing tests (Phase C).

Feb 2026 (Larissa 7 LLC): INTUIT deposits ($61k) were mis-routed to
Software & SaaS because the vendor rule was sign-agnostic and the
LLM defaults INTUIT to the QuickBooks subscription. Fixed by adding
`sign_variants` on bi-directional processor rules — INTUIT + credit
→ revenue_generic, INTUIT + debit → software_saas.

Same pattern applies to STRIPE, SQUARE, PAYPAL, VENMO, ZELLE,
CASH APP, APPLE CASH, GOOGLE PAY, AMAZON PAY.
"""
import os, sys
sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME"):
    if k in _env:
        os.environ.setdefault(k, _env[k].strip('"'))

from global_vendor_rules import match_and_resolve


TEMPLATE = "generic"


# ---------- INTUIT ---------------------------------------------------

def test_intuit_credit_routes_to_revenue():
    """QBO Payments merchant payout (money-in) → revenue_generic."""
    r = match_and_resolve("INTUIT DEPOSIT 268555", TEMPLATE, amount=1384.23)
    assert r is not None
    assert r["semantic"] == "revenue_generic"
    assert r["sign"] == "+"
    assert r["confidence"] >= 0.80


def test_intuit_debit_routes_to_software_saas():
    """QBO Online subscription (money-out) → software_saas."""
    r = match_and_resolve("INTUIT QBO SUBSCRIPTION", TEMPLATE, amount=-45.00)
    assert r is not None
    assert r["semantic"] == "software_saas"
    assert r["sign"] == "-"


def test_intuit_no_amount_falls_back_to_default_semantic():
    r = match_and_resolve("INTUIT", TEMPLATE, amount=None)
    assert r is not None
    # Default semantic when we don't have a sign signal.
    assert r["semantic"] == "software_saas"
    assert r["sign"] is None


# ---------- STRIPE ---------------------------------------------------

def test_stripe_credit_is_revenue():
    r = match_and_resolve("STRIPE ACH PAYOUT", TEMPLATE, amount=2500.0)
    assert r["semantic"] == "revenue_generic"
    assert r["sign"] == "+"


def test_stripe_debit_is_processing_fee():
    r = match_and_resolve("STRIPE FEE", TEMPLATE, amount=-12.50)
    assert r["semantic"] == "payment_processing_fees"
    assert r["sign"] == "-"


# ---------- PAYPAL ---------------------------------------------------

def test_paypal_credit_is_revenue():
    r = match_and_resolve("PAYPAL TRANSFER PPX*", TEMPLATE, amount=500.0)
    assert r["semantic"] == "revenue_generic"


def test_paypal_debit_defers_to_ambiguous_office_supplies():
    r = match_and_resolve("PAYPAL SOMEVENDOR", TEMPLATE, amount=-45.0)
    assert r["semantic"] == "office_supplies"
    assert r["confidence"] < 0.70   # marked ambiguous for review


# ---------- VENMO / ZELLE / CASH APP -------------------------------

def test_venmo_credit_is_owner_contribution():
    r = match_and_resolve("VENMO CASHIN", TEMPLATE, amount=1000.0)
    assert r["semantic"] == "owner_contribution"


def test_venmo_debit_is_owner_draw():
    r = match_and_resolve("VENMO PAYMENT", TEMPLATE, amount=-200.0)
    assert r["semantic"] == "owner_draw"


def test_zelle_flows_track_sign():
    assert match_and_resolve("ZELLE FROM SUSAN", TEMPLATE, amount=500.0)["semantic"] == "owner_contribution"
    assert match_and_resolve("ZELLE TO CONTRACTOR", TEMPLATE, amount=-500.0)["semantic"] == "owner_draw"


def test_cashapp_flows_track_sign():
    assert match_and_resolve("CASH APP PAYMENT", TEMPLATE, amount=-50.0)["semantic"] == "owner_draw"
    assert match_and_resolve("CASHAPP TRANSFER IN", TEMPLATE, amount=50.0)["semantic"] == "owner_contribution"


# ---------- SQUARE / GOOGLE PAY / AMAZON PAY ------------------------

def test_square_credit_is_revenue():
    r = match_and_resolve("SQUARE INC PAYOUT", TEMPLATE, amount=800.0)
    assert r["semantic"] == "revenue_generic"


def test_google_pay_credit_hints_revenue():
    r = match_and_resolve("GOOGLE PAY REFUND", TEMPLATE, amount=25.0)
    assert r["semantic"] == "revenue_generic"


def test_amazon_pay_credit_is_revenue():
    r = match_and_resolve("AMAZON PAY PAYOUT", TEMPLATE, amount=1200.0)
    assert r["semantic"] == "revenue_generic"


# ---------- Zero-amount edge case -----------------------------------

def test_zero_amount_uses_default_semantic():
    """Zero amount → no sign → fall back to top-level semantic
    (never crash and never accidentally book to the wrong side)."""
    r = match_and_resolve("INTUIT", TEMPLATE, amount=0.0)
    assert r["semantic"] == "software_saas"   # default fallback


# ---------- Regression: non-processor rules unchanged ---------------

def test_starbucks_unaffected_by_sign():
    """Rules WITHOUT sign_variants must behave exactly as before —
    a credit-side Starbucks (rare, but possible refund) still routes
    to meals, and we don't accidentally break the ~800 sign-agnostic
    rules by adding sign_variants to the resolver."""
    assert match_and_resolve("STARBUCKS #4321", TEMPLATE, amount=-7.50)["semantic"] == "meals"
    assert match_and_resolve("STARBUCKS REFUND", TEMPLATE, amount=7.50)["semantic"] == "meals"


def test_costco_amount_bucket_still_works():
    """Amount-bucket rules still work — sign_variants runs FIRST,
    but Costco has no sign_variants, only amount_buckets."""
    # Small purchase → meals
    r_small = match_and_resolve("COSTCO WHSE", TEMPLATE, amount=-45.0)
    # Large purchase → different (supplies / office_supplies)
    r_big   = match_and_resolve("COSTCO WHSE", TEMPLATE, amount=-450.0)
    assert r_small is not None and r_big is not None
    # (Don't hardcode exact bucket-semantic since Costco spec may
    # evolve; the important invariant is that small ≠ large.)
    assert r_small["semantic"] != r_big["semantic"] or r_small["bucket"] != r_big["bucket"]
