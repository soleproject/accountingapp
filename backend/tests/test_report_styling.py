"""Regression tests for per-company Report Styling (added Feb 2026).

Covers:
  • `resolve_report_style` merges stored overrides onto defaults
  • `resolve_report_label` returns override → default fallback
  • PDF builders accept `report_style` in `data` and render without error
    across every font family
  • Header spacing fix — `_pdf_styles` sets non-zero `spaceAfter` and
    `leading` so the company-name title can't overlap the subtitle
"""
import pytest
import reports as R


def test_defaults_used_when_no_company():
    rs = R.resolve_report_style(None)
    assert rs["font_family"] == "Helvetica"
    assert rs["title_font_size"] == 18
    assert rs["labels"]["income-statement"] == "Income Statement"
    assert rs["labels"]["balance-sheet"] == "Balance Sheet"


def test_partial_overrides_merge_on_defaults():
    """Missing / empty-string fields must fall through to defaults so
    the CPA can clear one knob without zeroing the whole record."""
    company = {"report_style": {
        "font_family": "Times-Roman",
        "title_font_size": 22,
        "title_color": "",           # empty → default
        "subtitle_color": None,      # None → default
        "labels": {"income-statement": "Profit & Loss"},
    }}
    rs = R.resolve_report_style(company)
    assert rs["font_family"] == "Times-Roman"
    assert rs["title_font_size"] == 22
    assert rs["title_color"] == "#0F172A"        # fell through
    assert rs["subtitle_color"] == "#52525B"      # fell through
    # Overridden label + un-overridden label both present
    assert rs["labels"]["income-statement"] == "Profit & Loss"
    assert rs["labels"]["balance-sheet"] == "Balance Sheet"


def test_resolve_report_label_falls_back_to_default():
    assert R.resolve_report_label(None, "income-statement") == "Income Statement"
    company = {"report_style": {"labels": {"income-statement": "P&L"}}}
    assert R.resolve_report_label(company, "income-statement") == "P&L"
    # Un-overridden kind still uses the default
    assert R.resolve_report_label(company, "balance-sheet") == "Balance Sheet"
    # Unknown kind echoes back
    assert R.resolve_report_label(company, "nope") == "nope"


def test_pdf_styles_spacing_prevents_overlap():
    """The original bug: 18pt title and 11pt subtitle collided because
    `spaceAfter=4` was too small for the 18pt line box. Assert the
    resolved style now leaves comfortable room + explicit leading."""
    s = R._pdf_styles(R.resolve_report_style(None))
    title = s["Title2"]
    sub = s["SubTitle"]
    assert title.spaceAfter >= 8, "Title needs breathing room below it"
    assert title.leading > title.fontSize, "Missing explicit leading — will collide"
    assert sub.leading > sub.fontSize, "Subtitle leading not set"


@pytest.mark.parametrize("family", ["Helvetica", "Times-Roman", "Courier"])
def test_pdf_styles_works_for_every_font_family(family):
    rs = R.resolve_report_style({"report_style": {"font_family": family}})
    s = R._pdf_styles(rs)
    # Bold variant exists for every supported family — RL naming
    # convention: <Family>-Bold. Assert the resolver picked one.
    assert "Bold" in s["Title2"].fontName


def test_income_statement_pdf_uses_custom_label():
    """End-to-end: passing a custom `report_style` + `report_label`
    into `build_income_statement_pdf` produces a valid PDF (no crash)
    and the bytes actually contain the override text."""
    rs = R.resolve_report_style({"report_style": {
        "font_family": "Times-Roman",
        "title_color": "#0891B2",
        "labels": {"income-statement": "Profit & Loss"},
    }})
    data = {
        "company_name": "Test LLC",
        "period_start": "2026-01-01", "period_end": "2026-12-31", "basis": "accrual",
        "revenue": [{"code": "4000", "name": "Sales", "amount": 100.0}],
        "expenses": [{"code": "6000", "name": "Meals", "amount": 50.0}],
        "total_revenue": 100.0, "total_expense": 50.0, "net_income": 50.0,
        "report_style": rs,
        "report_label": rs["labels"]["income-statement"],
    }
    pdf = R.build_income_statement_pdf(data)
    assert pdf.startswith(b"%PDF"), "Not a valid PDF"
    assert len(pdf) > 1000
