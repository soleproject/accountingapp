"""Lab pipeline Phase 1 — deterministic parser tests."""
import sys
sys.path.insert(0, "/app/backend")

from lab_pipeline.step2_parse import (
    parse_bank_desc, parse_paypal_boa,
    classify_channel, has_transfer_language,
    extract_dest_last4, infer_direction,
    CREDIT_REPAYMENT_TOKENS,
)


# --------------------------------------------------------------- direction

def test_direction_depository_outflow():
    assert infer_direction(amount=45.0, account_type="bank") == "out"

def test_direction_depository_inflow():
    assert infer_direction(amount=-500.0, account_type="bank") == "in"

def test_direction_credit_card_charge():
    # Credit card + positive amount = charge = outflow from business POV
    assert infer_direction(amount=100.0, account_type="credit") == "out"

def test_direction_credit_card_payment():
    # Credit card + negative = payment received to reduce liability
    assert infer_direction(amount=-100.0, account_type="credit_card") == "in"


# --------------------------------------------------------------- BoA parser

def test_boa_parses_full_indn_row():
    d = "PAYPAL DES:INST XFER ID:AMAZON INDN:MICHAEL GIORGI CO ID:PAYPALSI77 WEB"
    p = parse_bank_desc(d)
    assert p["format"] == "boa_ach"
    assert p["originator"] == "PAYPAL"
    assert p["des"] == "INST XFER"
    assert p["id_value"] == "AMAZON"
    assert p["indn"].lower() == "michael giorgi"
    assert p["co_id"].upper() == "PAYPALSI77"
    assert p["payment_channel"] == "WEB"

def test_boa_parses_citi_row():
    d = "CITI CARD ONLINE DES:PAYMENT ID:XXXX INDN:JANE DOE CO ID:CITICTP WEB"
    p = parse_bank_desc(d)
    assert p["format"] == "boa_ach"
    assert p["originator"] == "CITI CARD ONLINE"
    assert p["indn"] == "Jane Doe"

def test_non_boa_row_is_unparsed():
    p = parse_bank_desc("PURCHASE 0907 STARBUCKS DENVER CO XXXX1234")
    assert p["unparsed"]

def test_wells_fargo_ifi_tagged():
    p = parse_bank_desc("WELLS FARGO IFI DES:DDA TO DDA ID:F20X INDN:MICHAEL")
    # The full IFI row won't fully match our strict BoA regex — should
    # be tagged, not silently unparsed.
    assert p["unparsed"] is True
    assert p["format_tag"] == "wells_fargo_ifi"

def test_empty_desc_tagged_empty():
    p = parse_bank_desc("")
    assert p["unparsed"] and p["format_tag"] == "empty"


# --------------------------------------------------------------- PayPal BoA

def test_paypal_boa_credit_repayment():
    desc = "PAYPAL DES:INST XFER ID:CREDIT REPAYMEN INDN:JANE DOE CO ID:PAYPALSI77 WEB"
    p = parse_bank_desc(desc)
    r = parse_paypal_boa(p, amount=150.0)
    assert r["kind"] == "credit_account_payment"

def test_paypal_boa_purchase_outflow():
    desc = "PAYPAL DES:INST XFER ID:HOME DEPOT INDN:MICHAEL CO ID:PAYPALSI77 WEB"
    p = parse_bank_desc(desc)
    r = parse_paypal_boa(p, amount=45.0)
    assert r["kind"] == "merchant_purchase"
    assert r["merchant"].lower() == "home depot"

def test_paypal_boa_inflow_review():
    desc = "PAYPAL DES:INST XFER ID:JOHN CUSTOMER INDN:JANE CO ID:PAYPALSI77 WEB"
    p = parse_bank_desc(desc)
    r = parse_paypal_boa(p, amount=-500.0)
    assert r["kind"] == "inflow_review"

def test_paypal_boa_none_when_not_paypal():
    p = parse_bank_desc("CITI CARD ONLINE DES:PAYMENT ID:X INDN:J CO ID:CITICTP WEB")
    assert parse_paypal_boa(p, amount=100.0) is None


# --------------------------------------------------------------- channels

def test_channel_check():
    assert classify_channel(description="CHECK #1234 to John",
                             merchant=None, counterparties=None,
                             transaction_code=None, payment_channel=None,
                             check_number="1234", parsed=None) == "check"

def test_channel_wire():
    assert classify_channel(
        description="WIRE TYPE:WIRE IN DATE:250626 ORIG:ACME LLC",
        merchant=None, counterparties=None, transaction_code="wire",
        payment_channel=None, check_number=None, parsed=None) == "wire"

def test_channel_zelle():
    assert classify_channel(
        description="Zelle payment from JOHN Conf# XYZ",
        merchant=None, counterparties=None, transaction_code=None,
        payment_channel=None, check_number=None, parsed=None) == "zelle"

def test_channel_payment_app_venmo():
    assert classify_channel(
        description="VENMO DES:PAYMENT ID:12345 INDN:JOHN CO ID:VENMO WEB",
        merchant="Venmo", counterparties=None, transaction_code=None,
        payment_channel=None, check_number=None, parsed=None) == "payment_app"

def test_channel_transfer_language():
    assert classify_channel(
        description="ONLINE TRANSFER TO CHK ···6278",
        merchant=None, counterparties=None, transaction_code=None,
        payment_channel=None, check_number=None, parsed=None) == "transfer_language"

def test_channel_ach_boa_format():
    p = parse_bank_desc("STATE FARM DES:MTG PMT ID:12345 INDN:SMITH CO ID:STATEFARM PPD")
    assert classify_channel(
        description="STATE FARM DES:MTG PMT ID:12345 INDN:SMITH CO ID:STATEFARM PPD",
        merchant=None, counterparties=None, transaction_code=None,
        payment_channel="PPD", check_number=None, parsed=p) == "ach"

def test_channel_card_purchase():
    assert classify_channel(
        description="PURCHASE 0907 STARBUCKS DENVER CO",
        merchant="Starbucks", counterparties=None, transaction_code="place",
        payment_channel=None, check_number=None, parsed=None) == "card_purchase"


# --------------------------------------------------------------- helpers

def test_transfer_language_positive():
    assert has_transfer_language("ONLINE BANKING TRANSFER TO CHK 6278")
    assert has_transfer_language("WELLS FARGO IFI DES:DDA TO DDA")
    assert has_transfer_language("WIRE TRANSFER OUT")

def test_transfer_language_negative():
    assert not has_transfer_language("STARBUCKS 007 DENVER CO")

def test_extract_dest_last4():
    assert extract_dest_last4("ONLINE TRANSFER TO CHK 6278") == "6278"
    assert extract_dest_last4("Payment CARD ···1234") == "1234"
    assert extract_dest_last4("PURCHASE Home Depot") is None


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
