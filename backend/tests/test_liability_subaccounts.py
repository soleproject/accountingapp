"""Regression tests for the liability-subaccount fan-out logic.

Guards against two symptomatic bugs on 9-12-b, LLC in Feb 2026:
  1. Person's name (INDN accountholder) becoming a Current Liability
     GL account ("2130 Eimorlain Ugali").
  2. Card-issuer sub-accounts created from the wrong side of the
     ACH memo (contact_name resolved to accountholder instead of
     the card issuer named in the description).

The fix moved the "extract a canonical card issuer from the raw memo"
step BEFORE the payee-name fall-back, and added a person-name-shape
guard that refuses sub-account creation when the cleaned payee looks
like a natural person.
"""
import re
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from liability_subaccounts import (
    _extract_card_issuer,
    _looks_like_person_name,
    _clean_payee,
)


# --------------------------------------------------------------------------
# Card issuer extraction — the primary systemic fix. When the raw memo
# clearly names a card issuer, we use THAT (never the INDN person).
# --------------------------------------------------------------------------

def test_extract_citi_from_indn_memo():
    """Regression: 'CITI CARD ONLINE DES:PAYMENT ... INDN:EIMORLAIN G UGALI'
    used to create a GL account named 'Eimorlain Ugali' because the
    contact_resolver adopted the INDN person as counterparty. Now we
    extract 'Citi Card' straight from the raw memo before ever
    consulting contact_name."""
    memo = "CITI CARD ONLINE DES:PAYMENT ID:XXXXXXXXXX86909 INDN:EIMORLAIN G UGALI CO ID:CITICTP WEB"
    assert _extract_card_issuer(memo) == "Citi Card"


def test_extract_synchrony_from_syf_payment():
    """Synchrony credit cards route through PayPal MstrCRD with a
    'SYF PAYMNT' descriptor. The counterparty is Synchrony (the
    lender), never the INDN accountholder."""
    memo = "PayPal MstrCRD DES:SYF PAYMNT ID:XXXXXXXXXX20177 INDN:UGALIEIMORLAIN CO ID:XXXXX72103 TEL"
    assert _extract_card_issuer(memo) == "Synchrony"


def test_extract_chase_amex_capital_one():
    assert _extract_card_issuer("CHASE CREDIT CRD DES:AUTOPAY PPD ID:1234") == "Chase Card"
    assert _extract_card_issuer("AMEX EPAYMENT ACH PMT INDN:MICHAEL GIORGI") == "American Express"
    assert _extract_card_issuer("AMERICAN EXPRESS DES:ACH PMT") == "American Express"
    assert _extract_card_issuer("DISCOVER DES:E-PAYMENT") == "Discover"
    assert _extract_card_issuer("CAPITAL ONE CRCARDPMT ID:XXX") == "Capital One Card"


def test_extract_mortgage_and_auto_lenders():
    assert _extract_card_issuer("MR COOPER PMT PPD ID:1234") == "Mr. Cooper"
    assert _extract_card_issuer("ROCKET MORTGAGE PAYMENT") == "Rocket Mortgage"
    issuer = _extract_card_issuer("AUDI FINANCIAL SERVICES")
    assert issuer and "Audi" in issuer and "Financial" in issuer


def test_extract_returns_none_for_non_issuer():
    # Retail/food merchants — no lender pattern → None.
    assert _extract_card_issuer("CHEVRON GAS 1234") is None
    assert _extract_card_issuer("WHOLE FOODS #123") is None
    # Pure person name inside a Venmo memo is not a card issuer.
    assert _extract_card_issuer("EIMORLAIN UGALI VENMO") is None


# --------------------------------------------------------------------------
# Person-name shape guard — a natural person can never be the correct
# label for a company credit-card / loan sub-account.
# --------------------------------------------------------------------------

def test_person_names_are_detected():
    assert _looks_like_person_name("Eimorlain Ugali")
    assert _looks_like_person_name("Larry Brown")
    assert _looks_like_person_name("Larry D Brown")
    assert _looks_like_person_name("Michael F Giorgi")
    assert _looks_like_person_name("Kevin Petersen")


def test_business_names_are_not_persons():
    # Explicit business-entity keywords override the person-shape check.
    assert not _looks_like_person_name("Citi Card")
    assert not _looks_like_person_name("Rocket Mortgage")
    assert not _looks_like_person_name("Audi Financial")
    assert not _looks_like_person_name("Chase Bank")
    assert not _looks_like_person_name("LLC Holdings")
    # Card brands where the second token is a business hint (Express,
    # Discover, Synchrony).
    assert not _looks_like_person_name("American Express")


# --------------------------------------------------------------------------
# _clean_payee unchanged sanity — this used to be the whole story; now
# it's the fallback after card-issuer extraction.
# --------------------------------------------------------------------------

def test_clean_payee_still_strips_ach_cruft():
    assert _clean_payee("MR COOPER PMT PPD ID:1234") == "Mr. Cooper"
    assert _clean_payee("") is None
    assert _clean_payee("PAYMENT AUTOPAY") is None  # generic-transfer reject


# --------------------------------------------------------------------------
# End-to-end: given the exact 9-12-b, LLC bug payload, the raw-memo
# card issuer extraction picks Citi Card and the resolver would create
# a sub-account named "Citi Card" (not "Eimorlain Ugali").
# --------------------------------------------------------------------------

def test_e2e_citi_card_beats_indn_person():
    """The core regression: given a Citi credit-card payment ACH line
    whose contact_resolver mis-adopted the INDN accountholder as
    counterparty, the sub-account builder must pick 'Citi Card' — not
    the person name — as the sub-account label."""
    raw_memo = "CITI CARD ONLINE DES:PAYMENT ID:XXXXXXXXXX86909 INDN:EIMORLAIN G UGALI CO ID:CITICTP WEB"
    contact_name = "Eimorlain Ugali"  # wrongly resolved counterparty

    # Step 1: raw-memo extraction wins.
    issuer = _extract_card_issuer(raw_memo)
    assert issuer == "Citi Card"

    # Step 2: fall-back to contact_name would be REJECTED because it's a
    # person-shaped name. This is the second line of defense.
    cleaned_person = _clean_payee(contact_name)
    assert _looks_like_person_name(cleaned_person)


if __name__ == "__main__":
    # Standalone runner (no pytest infra required).
    import inspect, traceback
    ns = dict(globals())
    tests = [(k, v) for k, v in ns.items() if k.startswith("test_") and callable(v)]
    passed, failed = 0, 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
            passed += 1
        except AssertionError as e:
            print(f"FAIL {name}: {e or 'assertion'}")
            traceback.print_exc()
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
