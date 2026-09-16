"""Tests for the lab liability sub-account proposer (Feb-2026).

Covers:
* raw-memo → canonical issuer extraction (Capital One, Citi, Concora, …)
* bare car-brand routing to Loans Payable ("Audi" → 25xx bucket)
* bare retailer routing to Credit Card Payable ("Best Buy" → 21xx)
* INDN-style accountholder rejection ("Michael F Giorgi" → None)
* generic-transfer rejection ("Transfer", "Autopay")
"""
from __future__ import annotations
import pytest

from lab_pipeline.liability_subaccounts import (
    _CAR_BRAND_RE,
    _parent_bucket_for_issuer,
)
from liability_subaccounts import (
    _clean_payee,
    _extract_card_issuer,
    _looks_like_person_name,
)


# ---------------------------------------------------------------------
# _extract_card_issuer — canonical extraction from raw memo strings
# ---------------------------------------------------------------------

@pytest.mark.parametrize("memo,expected", [
    ("CITI CARD ONLINE DES:PAYMENT ID:XXX INDN:EIMORLAIN G UGALI",  "Citi Card"),
    ("PayPal MstrCRD DES:SYF PAYMNT ID:XXX INDN:UGALIEIMORLAIN",    "Synchrony"),
    ("Concora Credit",                                              "Concora Credit"),
    ("Credit One Bank DES:Payment ID:XXX INDN:MICHAEL GIORGI",      "Credit One Bank"),
    ("Rocket Mortgage",                                             "Rocket Mortgage"),
    ("Mercedes-Benz Financial",                                     "Mercedes-Benz Financial"),
    ("Ally Auto",                                                   "Ally Auto"),
])
def test_extract_card_issuer_hits(memo, expected):
    assert _extract_card_issuer(memo) == expected


def test_extract_card_issuer_misses_capital_one_without_crcardpmt():
    # Real-world Capital One mobile-app payments come through as
    # "CAPITAL ONE DES:MOBILE PMT ID:..." without the CRCARDPMT tag
    # that the strict issuer regex requires — end-to-end the proposer
    # still lands them under Credit Card Payable via the _clean_payee
    # fallback (verified in the pipeline run against Test 519 LLC).
    memo = "CAPITAL ONE DES:MOBILE PMT ID:CA08 INDN:Michael F Giorgi WEB"
    assert _extract_card_issuer(memo) is None


def test_extract_card_issuer_misses_bare_retailer():
    # Bare "Best Buy" doesn't have the CBNA suffix required by the card
    # regex — the proposer's fallback to _clean_payee handles this case.
    assert _extract_card_issuer("Best Buy") is None


def test_extract_card_issuer_misses_bare_car_brand():
    # Bare "Audi" doesn't match the dynamic auto-finance regex either —
    # the lab-side _CAR_BRAND_RE catches it downstream in
    # _parent_bucket_for_issuer.
    assert _extract_card_issuer("Audi") is None


# ---------------------------------------------------------------------
# _CAR_BRAND_RE — lab-only bare car-brand detector
# ---------------------------------------------------------------------

@pytest.mark.parametrize("name", [
    "Audi", "BMW", "Mercedes-Benz", "Toyota", "Honda", "Ford",
    "Chrysler", "GM", "Chevrolet", "Nissan", "Volkswagen", "Subaru",
    "Mazda", "Kia", "Hyundai", "Lexus", "Tesla", "Porsche",
    "Audi Financial", "Toyota Motor Credit", "Ford Credit",
])
def test_car_brand_matches(name):
    assert _CAR_BRAND_RE.match(name), f"expected match for {name!r}"


@pytest.mark.parametrize("name", [
    "Concora Credit", "Best Buy", "Capital One", "Stonebrook West",
    "Rocket Mortgage",  # covered by _LOAN_ISSUERS, not car-brand
])
def test_car_brand_no_match(name):
    assert not _CAR_BRAND_RE.match(name)


# ---------------------------------------------------------------------
# _parent_bucket_for_issuer — routing decision
# ---------------------------------------------------------------------

@pytest.mark.parametrize("issuer,parent", [
    ("Capital One Card",         "Credit Card Payable"),
    ("Citi Card",                "Credit Card Payable"),
    ("Concora Credit",           "Credit Card Payable"),
    ("Credit One Bank",          "Credit Card Payable"),
    ("Synchrony",                "Credit Card Payable"),
    ("Best Buy",                 "Credit Card Payable"),
    ("Stonebrook West",          "Credit Card Payable"),
    ("Audi",                     "Loans Payable"),
    ("BMW",                      "Loans Payable"),
    ("Mercedes-Benz Financial",  "Loans Payable"),
    ("Toyota Motor Credit",      "Loans Payable"),
    ("Mr. Cooper",               "Loans Payable"),
    ("Rocket Mortgage",          "Loans Payable"),
    ("Ally Auto",                "Loans Payable"),
])
def test_parent_bucket_routing(issuer, parent):
    got, _sub, _detail = _parent_bucket_for_issuer(issuer)
    assert got == parent


# ---------------------------------------------------------------------
# _looks_like_person_name — INDN accountholder rejection
# ---------------------------------------------------------------------

@pytest.mark.parametrize("name,is_person", [
    ("Michael F Giorgi",       True),
    ("EIMORLAIN G UGALI",      True),
    ("John Smith",             True),
    ("Concora Credit",         False),  # has business hint "Credit"
    ("Best Buy",               True),   # 2 tokens, no biz hint — but proposer relaxes for card context
    ("Audi",                   False),  # single token — not person-shaped
    ("Ally Auto",              True),   # 2 tokens, no biz hint — same relaxed case
])
def test_looks_like_person_name(name, is_person):
    assert _looks_like_person_name(name) is is_person


# ---------------------------------------------------------------------
# _clean_payee — ACH cruft stripping
# ---------------------------------------------------------------------

@pytest.mark.parametrize("memo,expected", [
    ("MR COOPER PMT PPD ID:1234",         "Mr. Cooper"),
    ("Transfer",                          None),
    ("Autopay",                           None),
    ("Online Banking Transfer",           None),
    ("",                                  None),
    ("BEST BUY",                          "Best Buy"),
])
def test_clean_payee(memo, expected):
    assert _clean_payee(memo) == expected
