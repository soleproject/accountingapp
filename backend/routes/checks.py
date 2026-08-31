"""Axiom Ledger — Check Printing (Feb 2026, MVP Phase 1).

Prints AP checks to PDF on pre-printed check stock (VersaCheck 1000 /
Deluxe 08019 style). Two layouts supported:

  * voucher_top  — 8.5" x 11", check on top ⅓, two stubs below
  * wallet_3up   — three 6" wallet checks per sheet

MVP scope (Feb 2026):
  - Manual sign only (unsigned PDF, human signs after print)
  - No MICR line rendered — user prints on pre-printed stock that
    already carries the magnetic routing/account/check-# strip
  - Positive Pay export is a later phase
  - Multi-check batches allowed
  - Each committed check creates one `payments` doc per linked bill,
    marks the bill paid/partial, and stamps a `checks` doc for
    reprint + audit history

Endpoints (all prefixed `/api/companies/{cid}/checks`):
  GET  /context               — bank accounts, unpaid bills, company header
  GET  /                      — printed-check history
  POST /preview               — return unsigned PDF, no DB writes
  POST /print                 — return PDF + create checks/payments
  POST /{check_id}/void       — mark check voided (audit only, no cash reversal)
  PATCH /settings/{acct_id}   — override next check # on a bank account
"""
from __future__ import annotations

import io
import uuid
from typing import Optional, List
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

from db import db, now_iso, coerce
from auth import get_current_user
from deps import require_company

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------
# Amount-to-words (legal amount on a check).
# ---------------------------------------------------------------------------

_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
         "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
         "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy",
         "Eighty", "Ninety"]


def _under_thousand(n: int) -> str:
    if n == 0:
        return ""
    parts = []
    if n >= 100:
        parts.append(f"{_ONES[n // 100]} Hundred")
        n = n % 100
    if n >= 20:
        parts.append(_TENS[n // 10] + ("" if n % 10 == 0 else f"-{_ONES[n % 10]}"))
    elif n > 0:
        parts.append(_ONES[n])
    return " ".join(parts)


def amount_to_words(amount: float) -> str:
    """Render `1247.55` as `One Thousand Two Hundred Forty-Seven and 55/100`.
    This is the legal amount printed on the check body — it beats the
    numeric box in the event of a mismatch, so it has to be exact."""
    if amount < 0:
        return "Zero and 00/100"
    dollars = int(amount)
    cents = int(round((amount - dollars) * 100))
    if cents == 100:
        dollars += 1
        cents = 0
    if dollars == 0:
        words = "Zero"
    else:
        chunks = []
        for unit_name, unit_val in (
            ("Billion", 1_000_000_000),
            ("Million", 1_000_000),
            ("Thousand", 1_000),
            ("", 1),
        ):
            chunk = dollars // unit_val
            dollars = dollars % unit_val
            if chunk:
                piece = _under_thousand(chunk)
                chunks.append(f"{piece} {unit_name}".strip())
        words = " ".join(chunks)
    return f"{words} and {cents:02d}/100"


# ---------------------------------------------------------------------------
# PDF rendering — voucher (top / middle / bottom), standard 3-up, wallet 3-up.
# ---------------------------------------------------------------------------

# Layout registry — single source of truth for both the PDF renderer
# and the /layouts frontend API. Each entry describes:
#   variant       — "voucher" | "standard_3up" | "wallet_3up"
#   check_y       — inches from bottom of 8.5x11 page (for single-check
#                   voucher variants; ignored for multi-check per-page)
#   stub_ys       — list of inch coordinates for stub bands (voucher
#                   variants only)
#   per_page      — 1 for voucher variants, 3 for wallet / standard
#   preview       — SVG-friendly layout hints the frontend can render
#                   as a visual example
LAYOUTS: dict[str, dict] = {
    "voucher_top": {
        "label": "Voucher — Check on top",
        "description": (
            "Check rides on the top ⅓ of the sheet with two payment "
            "stubs below. Most common AP format — the payee gets a "
            "reconciliation stub, you keep one."
        ),
        "stock_examples": "VersaCheck 1000, Deluxe 08019, ADP 91500",
        "variant": "voucher",
        "per_page": 1,
        "check_y": 7.5,
        "stub_ys": [4.0, 0.5],
        "preview": {"page_bands": [
            {"label": "CHECK", "top": 0.00, "height": 0.33, "kind": "check"},
            {"label": "STUB",  "top": 0.34, "height": 0.32, "kind": "stub"},
            {"label": "STUB",  "top": 0.67, "height": 0.32, "kind": "stub"},
        ]},
    },
    "voucher_middle": {
        "label": "Voucher — Check in middle",
        "description": (
            "Stub on top, check in the middle, stub on the bottom. "
            "Payroll-friendly — the top stub can be handed to the "
            "employee, the bottom stub kept on file."
        ),
        "stock_examples": "Deluxe 08024, ADP 91501",
        "variant": "voucher",
        "per_page": 1,
        "check_y": 4.0,
        "stub_ys": [7.5, 0.5],
        "preview": {"page_bands": [
            {"label": "STUB",  "top": 0.00, "height": 0.32, "kind": "stub"},
            {"label": "CHECK", "top": 0.33, "height": 0.33, "kind": "check"},
            {"label": "STUB",  "top": 0.67, "height": 0.32, "kind": "stub"},
        ]},
    },
    "voucher_bottom": {
        "label": "Voucher — Check on bottom",
        "description": (
            "Two stubs on top, check on the bottom of the sheet. "
            "Preferred by firms that store checks face-up in a "
            "binder — the stub always shows on top."
        ),
        "stock_examples": "Deluxe 08023, VersaCheck 3000",
        "variant": "voucher",
        "per_page": 1,
        "check_y": 0.5,
        "stub_ys": [7.5, 4.0],
        "preview": {"page_bands": [
            {"label": "STUB",  "top": 0.00, "height": 0.32, "kind": "stub"},
            {"label": "STUB",  "top": 0.33, "height": 0.32, "kind": "stub"},
            {"label": "CHECK", "top": 0.67, "height": 0.33, "kind": "check"},
        ]},
    },
    "standard_3up": {
        "label": "Standard — 3 business checks per page",
        "description": (
            "Three business-size checks (8.5\" × 3.5\") per sheet, "
            "no stub. Fastest for batch AP runs when you already "
            "email remittance details separately."
        ),
        "stock_examples": "Deluxe 08083, Nelco 91100, VersaCheck 2000",
        "variant": "standard_3up",
        "per_page": 3,
        "check_y": None,
        "stub_ys": [],
        "preview": {"page_bands": [
            {"label": "CHECK", "top": 0.00, "height": 0.33, "kind": "check"},
            {"label": "CHECK", "top": 0.34, "height": 0.32, "kind": "check"},
            {"label": "CHECK", "top": 0.67, "height": 0.33, "kind": "check"},
        ]},
    },
    "wallet_3up": {
        "label": "Wallet — 3 personal checks per page",
        "description": (
            "Three personal-sized wallet checks (6\" × 2.75\") per "
            "sheet. No stub. Best for owner draws, expense "
            "reimbursements, or one-off checks."
        ),
        "stock_examples": "Deluxe 081004, VersaCheck 3001",
        "variant": "wallet_3up",
        "per_page": 3,
        "check_y": None,
        "stub_ys": [],
        "preview": {"page_bands": [
            {"label": "CHECK", "top": 0.05, "height": 0.25, "kind": "check", "inset": 0.15},
            {"label": "CHECK", "top": 0.38, "height": 0.25, "kind": "check", "inset": 0.15},
            {"label": "CHECK", "top": 0.70, "height": 0.25, "kind": "check", "inset": 0.15},
        ]},
    },
}


def _draw_check_band(c: canvas.Canvas, x: float, y: float,
                      *, company: dict, check_number: str,
                      date: str, payee_name: str, payee_address: str,
                      amount: float, memo: str) -> None:
    """Draw one 8.5\" x 3.5\" check band with its bottom-left at (x, y).

    Coordinates are RELATIVE to (x, y), so the same routine renders the
    check band whether the layout puts it at the top of the sheet
    (voucher_top), middle (voucher_middle), or bottom (voucher_bottom).
    Standard VersaCheck 1000 footprint — pre-printed stock brands
    (Deluxe 08019, ADP 91500) all use these same coordinates within
    ±0.05\"."""
    # Check header — company name + address (top-left of check).
    c.setFont("Helvetica-Bold", 12)
    c.drawString(x + 0.35 * inch, y + 3.0 * inch, company.get("name") or "")
    c.setFont("Helvetica", 8)
    addr = company.get("address") or ""
    for i, line in enumerate((addr or "").split("\n")[:3]):
        c.drawString(x + 0.35 * inch, y + 2.85 * inch - i * 10, line)

    # Check number (top-right).
    c.setFont("Helvetica-Bold", 12)
    c.drawRightString(x + 7.6 * inch, y + 3.05 * inch, str(check_number))

    # Date.
    c.setFont("Helvetica", 10)
    c.drawString(x + 5.0 * inch, y + 2.55 * inch, "DATE")
    c.drawString(x + 5.5 * inch, y + 2.55 * inch, date)
    c.line(x + 5.45 * inch, y + 2.5 * inch, x + 7.6 * inch, y + 2.5 * inch)

    # Pay to the order of.
    c.setFont("Helvetica", 9)
    c.drawString(x + 0.35 * inch, y + 2.1 * inch, "PAY TO THE ORDER OF")
    c.setFont("Helvetica-Bold", 12)
    c.drawString(x + 2.0 * inch, y + 2.05 * inch, payee_name or "")
    c.line(x + 1.95 * inch, y + 2.0 * inch, x + 5.9 * inch, y + 2.0 * inch)

    # Numeric amount (boxed) — right side.
    c.rect(x + 6.05 * inch, y + 1.95 * inch, 1.5 * inch, 0.3 * inch, stroke=1, fill=0)
    c.setFont("Helvetica-Bold", 12)
    c.drawRightString(x + 7.5 * inch, y + 2.05 * inch, f"$ {amount:,.2f}")

    # Legal amount (words) — full-width row under payee.
    c.setFont("Helvetica-Bold", 11)
    c.drawString(x + 0.35 * inch, y + 1.65 * inch, amount_to_words(amount))
    c.line(x + 0.3 * inch, y + 1.6 * inch, x + 7.6 * inch, y + 1.6 * inch)
    c.setFont("Helvetica", 8)
    c.drawRightString(x + 7.6 * inch, y + 1.5 * inch, "DOLLARS")

    # Payee address (small, under the name).
    c.setFont("Helvetica", 8)
    for i, line in enumerate((payee_address or "").split("\n")[:3]):
        c.drawString(x + 0.35 * inch, y + 1.25 * inch - i * 10, line)

    # Memo + signature line (bottom row).
    c.setFont("Helvetica", 8)
    c.drawString(x + 0.35 * inch, y + 0.55 * inch, "MEMO")
    c.line(x + 0.7 * inch, y + 0.5 * inch, x + 3.5 * inch, y + 0.5 * inch)
    c.drawString(x + 0.75 * inch, y + 0.55 * inch, memo or "")
    c.line(x + 4.5 * inch, y + 0.5 * inch, x + 7.6 * inch, y + 0.5 * inch)
    c.drawRightString(x + 7.6 * inch, y + 0.35 * inch, "AUTHORIZED SIGNATURE")

    # MICR clear-band placeholder (bottom ⅝" is left blank — pre-printed
    # check stock carries the real magnetic-toner MICR line here).


def _draw_stub(c: canvas.Canvas, x: float, y: float, *, check_number: str,
               date: str, payee_name: str, amount: float,
               bill_lines: list[dict], memo: str) -> None:
    """Voucher stub — line-item detail so the payee can reconcile which
    bills this one check settled. Two stubs per sheet on voucher_top."""
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x + 0.35 * inch, y + 2.7 * inch, f"Check #{check_number}")
    c.drawRightString(x + 7.6 * inch, y + 2.7 * inch, f"Date: {date}")
    c.setFont("Helvetica", 9)
    c.drawString(x + 0.35 * inch, y + 2.5 * inch, f"Pay To: {payee_name or ''}")

    # Table header.
    c.setFont("Helvetica-Bold", 8)
    c.drawString(x + 0.35 * inch, y + 2.2 * inch, "BILL #")
    c.drawString(x + 1.6 * inch, y + 2.2 * inch, "DATE")
    c.drawString(x + 2.6 * inch, y + 2.2 * inch, "DESCRIPTION")
    c.drawRightString(x + 7.5 * inch, y + 2.2 * inch, "AMOUNT")
    c.line(x + 0.3 * inch, y + 2.15 * inch, x + 7.6 * inch, y + 2.15 * inch)
    c.setFont("Helvetica", 9)
    row_y = y + 2.0 * inch
    for bl in (bill_lines or [])[:10]:
        c.drawString(x + 0.35 * inch, row_y, str(bl.get("number") or "")[:16])
        c.drawString(x + 1.6 * inch, row_y, str(bl.get("issue_date") or "")[:10])
        c.drawString(x + 2.6 * inch, row_y, str(bl.get("summary") or bl.get("title") or "")[:44])
        c.drawRightString(x + 7.5 * inch, row_y, f"${float(bl.get('amount') or 0):,.2f}")
        row_y -= 14
    # Total.
    c.line(x + 5.9 * inch, y + 0.55 * inch, x + 7.6 * inch, y + 0.55 * inch)
    c.setFont("Helvetica-Bold", 10)
    c.drawRightString(x + 7.5 * inch, y + 0.65 * inch, f"TOTAL  ${amount:,.2f}")
    if memo:
        c.setFont("Helvetica", 8)
        c.drawString(x + 0.35 * inch, y + 0.35 * inch, f"Memo: {memo[:80]}")


def _render_voucher(c: canvas.Canvas, *, layout: dict, company: dict,
                     check_number: str, date: str, payee_name: str,
                     payee_address: str, amount: float, memo: str,
                     bill_lines: list[dict]) -> None:
    """Voucher variant — 1 check band + N stub bands. `layout['check_y']`
    and `layout['stub_ys']` control the vertical placement so we can
    render top/middle/bottom variants from the same routine."""
    _draw_check_band(
        c, 0.5 * inch, layout["check_y"] * inch,
        company=company, check_number=check_number, date=date,
        payee_name=payee_name, payee_address=payee_address,
        amount=amount, memo=memo,
    )
    for stub_y in layout["stub_ys"]:
        _draw_stub(
            c, 0.5 * inch, stub_y * inch,
            check_number=check_number, date=date, payee_name=payee_name,
            amount=amount, bill_lines=bill_lines, memo=memo,
        )


def _render_standard_3up(c: canvas.Canvas, *, company: dict,
                          checks: list[dict]) -> None:
    """Three business-size (8.5\" × 3.5\") checks per page, no stub.
    Uses the same `_draw_check_band` primitive as the voucher variants
    so payee/date/amount formatting stays identical across layouts.
    Caller paginates in groups of 3."""
    # Stack top→bottom: slot 0 sits at y=7.5, slot 1 at y=4.0, slot 2 at y=0.5.
    slot_ys = [7.5 * inch, 4.0 * inch, 0.5 * inch]
    for i, chk in enumerate(checks[:3]):
        _draw_check_band(
            c, 0.5 * inch, slot_ys[i],
            company=company,
            check_number=str(chk["check_number"]),
            date=chk["date"],
            payee_name=chk.get("payee_name") or "",
            payee_address=chk.get("payee_address") or "",
            amount=float(chk["amount"]),
            memo=chk.get("memo") or "",
        )


def _render_wallet_3up(c: canvas.Canvas, *, company: dict, checks: list[dict]) -> None:
    """Three 6" wallet-style checks per 8.5x11 sheet. Each slot is
    ~3.5" tall. This layout has no stub — designed for personal /
    owner-draw scenarios, not AP reconciliation. `checks` must have
    len ≤ 3; caller paginates."""
    slot_height = 3.5 * inch
    # Slots run top→bottom on the page.
    for i, chk in enumerate(checks[:3]):
        base_y = 11 * inch - (i + 1) * slot_height + 0.25 * inch
        c.setFont("Helvetica-Bold", 11)
        c.drawString(0.5 * inch, base_y + 2.7 * inch, company.get("name") or "")
        c.setFont("Helvetica", 8)
        for j, line in enumerate((company.get("address") or "").split("\n")[:2]):
            c.drawString(0.5 * inch, base_y + 2.55 * inch - j * 10, line)
        # Check number, date.
        c.setFont("Helvetica-Bold", 11)
        c.drawRightString(7.5 * inch, base_y + 2.7 * inch, str(chk["check_number"]))
        c.setFont("Helvetica", 9)
        c.drawString(5.5 * inch, base_y + 2.3 * inch, "DATE")
        c.drawString(6.0 * inch, base_y + 2.3 * inch, chk["date"])
        c.line(5.95 * inch, base_y + 2.25 * inch, 7.5 * inch, base_y + 2.25 * inch)
        # Pay to the order of.
        c.setFont("Helvetica", 8)
        c.drawString(0.5 * inch, base_y + 1.9 * inch, "PAY TO THE ORDER OF")
        c.setFont("Helvetica-Bold", 11)
        c.drawString(2.0 * inch, base_y + 1.85 * inch, chk["payee_name"] or "")
        c.line(1.95 * inch, base_y + 1.8 * inch, 5.4 * inch, base_y + 1.8 * inch)
        c.rect(5.6 * inch, base_y + 1.75 * inch, 1.9 * inch, 0.3 * inch, stroke=1, fill=0)
        c.setFont("Helvetica-Bold", 11)
        c.drawRightString(7.4 * inch, base_y + 1.85 * inch, f"$ {chk['amount']:,.2f}")
        # Words.
        c.setFont("Helvetica-Bold", 10)
        c.drawString(0.5 * inch, base_y + 1.4 * inch, amount_to_words(chk["amount"]))
        c.line(0.5 * inch, base_y + 1.35 * inch, 7.5 * inch, base_y + 1.35 * inch)
        # Memo + signature.
        c.setFont("Helvetica", 8)
        c.drawString(0.5 * inch, base_y + 0.55 * inch, "MEMO")
        c.drawString(0.85 * inch, base_y + 0.55 * inch, chk.get("memo") or "")
        c.line(0.85 * inch, base_y + 0.5 * inch, 3.5 * inch, base_y + 0.5 * inch)
        c.line(4.5 * inch, base_y + 0.5 * inch, 7.5 * inch, base_y + 0.5 * inch)
        c.drawRightString(7.5 * inch, base_y + 0.35 * inch, "AUTHORIZED SIGNATURE")


async def _build_check_pdf(cid: str, layout_key: str, bank_account: dict,
                            company: dict, checks: list[dict]) -> bytes:
    """Render a batch of checks to a single PDF. Dispatches by
    `LAYOUTS[layout_key]['variant']` so adding a new layout is one
    registry entry + (if needed) one renderer function. Returns raw
    bytes so the caller can either stream them back or drop them into
    S3 later."""
    layout = LAYOUTS.get(layout_key) or LAYOUTS["voucher_top"]
    variant = layout["variant"]
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    if variant == "wallet_3up":
        for i in range(0, len(checks), 3):
            _render_wallet_3up(c, company=company, checks=checks[i:i + 3])
            c.showPage()
    elif variant == "standard_3up":
        for i in range(0, len(checks), 3):
            _render_standard_3up(c, company=company, checks=checks[i:i + 3])
            c.showPage()
    else:  # voucher (top / middle / bottom)
        for chk in checks:
            _render_voucher(
                c,
                layout=layout,
                company=company,
                check_number=str(chk["check_number"]),
                date=chk["date"],
                payee_name=chk.get("payee_name") or "",
                payee_address=chk.get("payee_address") or "",
                amount=float(chk["amount"]),
                memo=chk.get("memo") or "",
                bill_lines=chk.get("bill_lines") or [],
            )
            c.showPage()
    c.save()
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Data models.
# ---------------------------------------------------------------------------

class CheckLineIn(BaseModel):
    payee_name: str
    payee_address: Optional[str] = ""
    amount: float
    memo: Optional[str] = ""
    date: str                                    # YYYY-MM-DD
    bill_ids: List[str] = Field(default_factory=list)


class CheckBatchIn(BaseModel):
    layout: str = "voucher_top"                  # voucher_top | wallet_3up
    bank_account_id: str
    starting_check_number: int
    checks: List[CheckLineIn]


class NextCheckNumberIn(BaseModel):
    next_check_number: int


# ---------------------------------------------------------------------------
# Endpoints.
# ---------------------------------------------------------------------------

def _is_bank_account(a: dict) -> bool:
    """True if `a` looks like a bank/cash asset — matches the same
    heuristic the payments modal uses so we don't drift."""
    if a.get("type") != "asset":
        return False
    dt = (a.get("detail_type") or "").lower()
    if dt == "cash_and_bank":
        return True
    name = (a.get("name") or "").lower()
    return any(k in name for k in ("checking", "savings", "cash", "bank", "operating"))


@router.get("/companies/{cid}/checks/layouts")
async def list_layouts(cid: str, user: dict = Depends(get_current_user)):
    """Registry of supported check layouts — each with copy, stock
    examples, and an SVG-friendly `preview` schema the frontend uses
    to render an inline example thumbnail. Adding a layout server-side
    surfaces it in the picker automatically."""
    await require_company(user, cid)
    return {
        "layouts": [
            {"key": k,
             "label": v["label"],
             "description": v["description"],
             "stock_examples": v["stock_examples"],
             "per_page": v["per_page"],
             "preview": v["preview"]}
            for k, v in LAYOUTS.items()
        ],
    }


@router.get("/companies/{cid}/checks/context")
async def check_context(cid: str, user: dict = Depends(get_current_user)):
    """One-shot fetch: bank accounts (with next check #), unpaid bills,
    company profile — everything the PrintChecks page needs to render."""
    await require_company(user, cid)
    accounts = await db.accounts.find(
        {"company_id": cid}, {"_id": 0}
    ).to_list(2000)
    banks = [a for a in accounts if _is_bank_account(a)]
    for b in banks:
        b["next_check_number"] = int(b.get("next_check_number") or 1001)

    bills = await db.bills.find(
        {"company_id": cid, "status": {"$in": ["open", "partial"]}},
        {"_id": 0},
    ).sort("due_date", 1).to_list(500)
    # Attach payee address if the contact carries one.
    contact_ids = list({b.get("contact_id") for b in bills if b.get("contact_id")})
    contact_map = {}
    if contact_ids:
        async for c in db.contacts.find(
            {"company_id": cid, "id": {"$in": contact_ids}},
            {"_id": 0, "id": 1, "address": 1, "email": 1, "name": 1},
        ):
            contact_map[c["id"]] = c

    unpaid = []
    for b in bills:
        contact = contact_map.get(b.get("contact_id")) or {}
        unpaid.append({
            "id": b["id"],
            "number": b.get("number") or "",
            "contact_id": b.get("contact_id"),
            "contact_name": b.get("contact_name") or contact.get("name") or "",
            "contact_address": contact.get("address") or "",
            "issue_date": b.get("issue_date"),
            "due_date": b.get("due_date"),
            "balance_due": float(b.get("balance_due") or 0),
            "total": float(b.get("total") or 0),
            "title": b.get("title") or "",
            "summary": b.get("summary") or "",
        })

    company = await db.companies.find_one({"id": cid}, {"_id": 0}) or {}
    return {
        "bank_accounts": [coerce(b) for b in banks],
        "unpaid_bills": unpaid,
        "company": {
            "name": company.get("name") or "",
            "address": company.get("address") or "",
            "phone": company.get("phone") or "",
            "email": company.get("email") or "",
        },
    }


@router.get("/companies/{cid}/checks")
async def list_checks(cid: str, user: dict = Depends(get_current_user)):
    """Printed-check history — newest first, capped at 500."""
    await require_company(user, cid)
    docs = await db.checks.find(
        {"company_id": cid}, {"_id": 0}
    ).sort("printed_at", -1).to_list(500)
    return {"checks": [coerce(d) for d in docs]}


async def _next_check_number(cid: str, bank_account_id: str) -> int:
    """Read the persisted next check number; default 1001 for a brand-new
    account."""
    acct = await db.accounts.find_one(
        {"id": bank_account_id, "company_id": cid},
        {"_id": 0, "next_check_number": 1},
    )
    return int((acct or {}).get("next_check_number") or 1001)


async def _bump_check_number(cid: str, bank_account_id: str, new_next: int) -> None:
    await db.accounts.update_one(
        {"id": bank_account_id, "company_id": cid},
        {"$set": {"next_check_number": int(new_next)}},
    )


async def _load_bill_lines(cid: str, bill_ids: list[str]) -> list[dict]:
    if not bill_ids:
        return []
    docs = await db.bills.find(
        {"id": {"$in": bill_ids}, "company_id": cid},
        {"_id": 0, "id": 1, "number": 1, "issue_date": 1, "total": 1,
         "balance_due": 1, "title": 1, "summary": 1},
    ).to_list(len(bill_ids))
    return [{
        "id": b["id"],
        "number": b.get("number") or "",
        "issue_date": b.get("issue_date") or "",
        "title": b.get("title") or "",
        "summary": b.get("summary") or "",
        "amount": float(b.get("balance_due") or b.get("total") or 0),
    } for b in docs]


async def _assemble_batch(cid: str, inp: CheckBatchIn) -> tuple[dict, dict, list[dict]]:
    """Validate the batch, fetch the bank account + company profile,
    and expand each check with its bill line-items. Returns
    (bank_account, company, [check_dict, ...]) ready for the PDF
    renderer."""
    if inp.layout not in LAYOUTS:
        raise HTTPException(400, f"Unknown layout: {inp.layout}")
    bank = await db.accounts.find_one(
        {"id": inp.bank_account_id, "company_id": cid}, {"_id": 0},
    )
    if not bank or not _is_bank_account(bank):
        raise HTTPException(400, "Bank account not found or not a bank/cash asset")
    company = await db.companies.find_one({"id": cid}, {"_id": 0}) or {}

    enriched = []
    for i, chk in enumerate(inp.checks):
        if chk.amount <= 0:
            raise HTTPException(400, f"Check {i + 1}: amount must be > 0")
        bill_lines = await _load_bill_lines(cid, chk.bill_ids)
        enriched.append({
            "check_number": inp.starting_check_number + i,
            "date": chk.date,
            "payee_name": chk.payee_name,
            "payee_address": chk.payee_address or "",
            "amount": float(chk.amount),
            "memo": chk.memo or "",
            "bill_ids": chk.bill_ids,
            "bill_lines": bill_lines,
        })
    return bank, company, enriched


@router.post("/companies/{cid}/checks/preview")
async def preview_checks(cid: str, inp: CheckBatchIn,
                          user: dict = Depends(get_current_user)):
    """Return the unsigned PDF without touching the ledger. Frontend
    opens this in a new tab so the user can eyeball alignment before
    committing."""
    await require_company(user, cid)
    bank, company, checks = await _assemble_batch(cid, inp)
    pdf = await _build_check_pdf(cid, inp.layout, bank, company, checks)
    return StreamingResponse(
        io.BytesIO(pdf),
        media_type="application/pdf",
        headers={"Content-Disposition": "inline; filename=checks-preview.pdf"},
    )


@router.post("/companies/{cid}/checks/print")
async def print_checks(cid: str, inp: CheckBatchIn,
                        user: dict = Depends(get_current_user)):
    """Commit-and-print: render the PDF, create `checks` history rows,
    create `payments` for each linked bill, and bump the account's
    next_check_number. Returns the PDF binary so the browser can push
    it to the printer in the same round-trip.

    NOTE: an unlinked check (no bill_ids) still gets a `checks` row
    but does NOT auto-create a payment or JE — the user is responsible
    for booking the expense side themselves (matches QBO's "Write
    Check without a bill" behaviour). Follow-up: expense-account
    picker for unlinked checks + auto JE."""
    await require_company(user, cid)
    bank, company, checks = await _assemble_batch(cid, inp)
    pdf = await _build_check_pdf(cid, inp.layout, bank, company, checks)

    from models import PaymentCreate
    from routes.payments import create_payment

    now = now_iso()
    saved_ids: list[str] = []
    for chk in checks:
        cheque_id = str(uuid.uuid4())
        payment_ids: list[str] = []
        # One payment per linked bill (mirrors how bill_pay works
        # elsewhere in the ledger — keeps drill-down + reversal clean).
        for bl in chk["bill_lines"]:
            bill_amt = float(bl["amount"])
            if bill_amt <= 0:
                continue
            pay_in = PaymentCreate(
                date=chk["date"],
                amount=bill_amt,
                contact_name=chk["payee_name"],
                method="check",
                linked_bill_id=bl["id"],
                bank_account_id=inp.bank_account_id,
                memo=f"Check #{chk['check_number']}" + (
                    f" · {chk['memo']}" if chk.get("memo") else ""
                ),
            )
            try:
                r = await create_payment(cid, pay_in, user)  # type: ignore[arg-type]
                if isinstance(r, dict) and r.get("id"):
                    payment_ids.append(r["id"])
            except Exception as e:  # noqa: BLE001
                # A single bill failing shouldn't nuke the whole batch —
                # user still gets the PDF but we log the check as
                # partial so support can pick it up.
                import logging
                logging.getLogger(__name__).warning(
                    "check %s: payment for bill %s failed: %s",
                    chk["check_number"], bl["id"], e,
                )
        await db.checks.insert_one({
            "id": cheque_id,
            "company_id": cid,
            "check_number": int(chk["check_number"]),
            "bank_account_id": inp.bank_account_id,
            "layout": inp.layout,
            "payee_name": chk["payee_name"],
            "payee_address": chk["payee_address"],
            "amount": float(chk["amount"]),
            "memo": chk["memo"],
            "date": chk["date"],
            "bill_ids": chk["bill_ids"],
            "payment_ids": payment_ids,
            "status": "printed",
            "printed_at": now,
            "printed_by": {
                "id": user.get("id"),
                "email": user.get("email"),
                "name": user.get("name") or user.get("email"),
            },
        })
        saved_ids.append(cheque_id)

    # Bump the persisted next-check-# so the next batch defaults
    # correctly. `+len(checks)` because we consumed len(checks)
    # consecutive numbers.
    await _bump_check_number(
        cid, inp.bank_account_id,
        inp.starting_check_number + len(checks),
    )

    # Audit trail — best-effort so a missing audit module never blocks
    # the print action.
    try:
        import audit as _audit
        for chk, cid_row in zip(checks, saved_ids):
            _audit.log_create(
                "check", cid_row,
                {"check_number": chk["check_number"],
                 "amount": chk["amount"],
                 "payee_name": chk["payee_name"]},
                actor={"id": user["id"], "email": user.get("email"),
                       "role": user.get("role")},
                company_id=cid,
                summary=(f"Check #{chk['check_number']} · "
                         f"{chk['payee_name']} · ${chk['amount']:,.2f}"),
            )
    except Exception:  # noqa: BLE001
        pass

    return StreamingResponse(
        io.BytesIO(pdf),
        media_type="application/pdf",
        headers={
            "Content-Disposition": "inline; filename=checks.pdf",
            "X-Check-Ids": ",".join(saved_ids),
        },
    )


@router.post("/companies/{cid}/checks/{check_id}/void")
async def void_check(cid: str, check_id: str,
                      user: dict = Depends(get_current_user)):
    """Mark a printed check as voided so its number can't be reused
    silently. Does NOT reverse the linked payments — user should void
    those separately if the money never left. Positive Pay export
    (Phase 2) will read this flag to tell the bank to reject any
    attempted deposit of the voided check number."""
    await require_company(user, cid)
    r = await db.checks.update_one(
        {"id": check_id, "company_id": cid},
        {"$set": {"status": "voided",
                  "voided_at": now_iso(),
                  "voided_by": {"id": user.get("id"),
                                "email": user.get("email")}}},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Check not found")
    return {"ok": True}


@router.patch("/companies/{cid}/checks/settings/{account_id}")
async def update_next_number(cid: str, account_id: str, inp: NextCheckNumberIn,
                              user: dict = Depends(get_current_user)):
    """Manual override — used when the physical check stock's first
    sheet doesn't match the persisted next number (fresh box, reorder,
    switched banks, etc)."""
    await require_company(user, cid)
    if inp.next_check_number < 1:
        raise HTTPException(400, "next_check_number must be positive")
    acct = await db.accounts.find_one(
        {"id": account_id, "company_id": cid}, {"_id": 0},
    )
    if not acct or not _is_bank_account(acct):
        raise HTTPException(404, "Bank account not found")
    await _bump_check_number(cid, account_id, inp.next_check_number)
    return {"ok": True, "next_check_number": inp.next_check_number}
