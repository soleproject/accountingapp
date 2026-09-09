"""Veryfi auto-match — pure-logic tests for the scoring function.

The upload path calls Veryfi (network) so it's e2e-tested elsewhere.
Here we lock in the deterministic `_score_match` weights so a refactor
of the confidence thresholds can't silently break the "which receipt
belongs to which transaction" contract.
"""
from routes.client_portal import _score_match, _veryfi_receipt_fields


def _fields(vendor=None, total=None, date=None):
    return {"vendor_name": vendor, "total": total, "date": date}


def test_score_exact_match_scores_near_one():
    txn = {"amount": -42.50, "date": "2026-02-14", "description": "AWS charge"}
    got = _score_match(txn, _fields(vendor="AWS", total=42.50, date="2026-02-14"))
    # 0.55 amount exact + 0.25 date exact + 0.20 vendor = 1.00
    assert got >= 0.95


def test_score_amount_within_5pct_and_close_date():
    txn = {"amount": -100.00, "date": "2026-02-14", "description": "Uber trip"}
    got = _score_match(txn, _fields(vendor="Uber", total=104.00, date="2026-02-16"))
    # 4% off (0.35) + 2 days (0.15) + vendor match (0.20) = 0.70
    assert 0.60 <= got <= 0.80


def test_score_amount_off_by_more_than_5pct_returns_zero():
    txn = {"amount": -100.00, "date": "2026-02-14", "description": "Uber"}
    got = _score_match(txn, _fields(vendor="Uber", total=200.00, date="2026-02-14"))
    assert got == 0.0


def test_score_date_more_than_week_off_returns_zero():
    txn = {"amount": -50.00, "date": "2026-02-14", "description": "Uber"}
    got = _score_match(txn, _fields(vendor="Uber", total=50.00, date="2026-03-01"))
    assert got == 0.0


def test_score_no_vendor_still_matches_on_amount_and_date():
    txn = {"amount": -25.00, "date": "2026-02-14", "description": "purchase"}
    got = _score_match(txn, _fields(vendor=None, total=25.00, date="2026-02-14"))
    # 0.55 + 0.25 = 0.80 → still comfortably above the 0.6 threshold.
    assert got >= 0.75


def test_receipt_fields_extraction_handles_nested_and_flat():
    data_flat = {"vendor": "AWS", "total": "42.50", "date": "2026-02-14"}
    got = _veryfi_receipt_fields(data_flat)
    assert got == {"vendor_name": "AWS", "total": 42.50, "date": "2026-02-14"}

    data_nested = {
        "vendor": {"name": "Uber Technologies"},
        "total": {"value": 104.00},
        "date": {"value": "2026-02-16T10:30:00Z"},
    }
    got = _veryfi_receipt_fields(data_nested)
    assert got == {"vendor_name": "Uber Technologies", "total": 104.00, "date": "2026-02-16"}
