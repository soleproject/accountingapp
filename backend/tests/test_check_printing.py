"""Check-printing smoke tests — verifies the amount-in-words helper +
the PDF renderer produce valid output. Full end-to-end (bill → check
→ payment) is covered manually in the preview; adding a Motor-fixture
integration test is a Phase-2 nice-to-have.
"""
from routes.checks import amount_to_words, _build_check_pdf
import asyncio


def test_amount_to_words_edges():
    assert amount_to_words(0) == "Zero and 00/100"
    assert amount_to_words(1) == "One and 00/100"
    assert amount_to_words(1_247.55) == "One Thousand Two Hundred Forty-Seven and 55/100"
    assert amount_to_words(100.00) == "One Hundred and 00/100"
    assert amount_to_words(1_000_000) == "One Million and 00/100"
    # Cent rounding — .999 rolls up to next dollar with cents=00.
    assert amount_to_words(25.999) == "Twenty-Six and 00/100"
    # Standard split.
    assert amount_to_words(19.50) == "Nineteen and 50/100"
    assert amount_to_words(1042.00) == "One Thousand Forty-Two and 00/100"


def test_voucher_pdf_renders():
    """Every voucher variant (top / middle / bottom) must produce a
    non-empty PDF byte-string starting with the %PDF magic header.
    Enough of a smoke test to catch ReportLab or coordinate-math
    regressions when we add or move a stub band."""
    checks = [{
        "check_number": 1001,
        "date": "2026-02-28",
        "payee_name": "Acme Supplies, Inc.",
        "payee_address": "123 Main St\nAnytown, USA 12345",
        "amount": 1247.55,
        "memo": "Invoice #47",
        "bill_lines": [
            {"number": "BILL-47", "issue_date": "2026-02-15",
             "summary": "Widgets Q1", "amount": 1247.55},
        ],
    }]
    for k in ("voucher_top", "voucher_middle", "voucher_bottom"):
        pdf = asyncio.run(_build_check_pdf(
            "cid", k,
            {"name": "Test Bank"},
            {"name": "Test Co", "address": "1 First St"},
            checks,
        ))
        assert pdf.startswith(b"%PDF-"), f"{k}: not a valid PDF"
        assert len(pdf) > 500, f"{k}: PDF suspiciously small"


def test_standard_3up_pdf_renders():
    """Standard 3-up (business, no stubs) must accept 5 checks and
    paginate them across 2 sheets."""
    checks = [
        {"check_number": 1001 + i, "date": "2026-02-28",
         "payee_name": f"Vendor {i}", "payee_address": "",
         "amount": 100.00 + i, "memo": f"Memo {i}", "bill_lines": []}
        for i in range(5)
    ]
    pdf = asyncio.run(_build_check_pdf(
        "cid", "standard_3up",
        {"name": "Test Bank"},
        {"name": "Test Co", "address": ""},
        checks,
    ))
    assert pdf.startswith(b"%PDF-")


def test_wallet_pdf_renders():
    """Wallet 3-up must accept multiple checks and paginate them."""
    checks = [
        {"check_number": 1001 + i, "date": "2026-02-28",
         "payee_name": f"Vendor {i}", "payee_address": "",
         "amount": 100.00 + i, "memo": f"Memo {i}", "bill_lines": []}
        for i in range(5)                                 # 5 checks → 2 pages
    ]
    pdf = asyncio.run(_build_check_pdf(
        "cid", "wallet_3up",
        {"name": "Test Bank"},
        {"name": "Test Co", "address": ""},
        checks,
    ))
    assert pdf.startswith(b"%PDF-")


def test_layout_registry_has_previews():
    """Every registered layout must expose the `preview.page_bands`
    schema the frontend consumes — regression guard against adding a
    backend-only layout the picker can't render an example of."""
    from routes.checks import LAYOUTS
    for k, v in LAYOUTS.items():
        assert v.get("preview", {}).get("page_bands"), f"{k} missing preview"
        for b in v["preview"]["page_bands"]:
            assert set(b.keys()) >= {"label", "top", "height", "kind"}
            assert b["kind"] in ("check", "stub")
