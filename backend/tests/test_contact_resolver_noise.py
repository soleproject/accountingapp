"""`contact_resolver.looks_noisy` + `is_bank_fee_row` regression tests.

Locks in the Feb 2026 anti-junk-contact guards added after the
Larissa 5 LLC upload minted "contacts" like:
    "110 Nov. 21 350.00 111 Nov. 24 378.00"        (check-register OCR)
    "39763343 TRAN FEE 5247719998897619215986202"  (fee row w/ trace #)
    "72075183TRAN FEE 5247719998897619215986202"   (concat number+fee)

Rules enforced:
  1. Merchant strings with >3 digits are noisy.
  2. Merchant strings ≥8 chars with ≥30% digit density are noisy.
  3. Any string containing bank-fee vocabulary (TRAN FEE, SERVICE
     CHARGE, MAINTENANCE FEE, INTEREST PAID, WIRE FEE, …) is noisy
     AND marked `is_bank_fee_row`.
  4. Check-register OCR sidebars (`128 Dec. 24 187.00 …`) are noisy.
  5. Clean short vendor names (Starbucks, AT&T, 7-Eleven, IKEA)
     still pass through as NOT noisy — no over-fitting.
"""
import os, sys
sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME"):
    if k in _env:
        os.environ.setdefault(k, _env[k].strip('"'))

from contact_resolver import looks_noisy, is_bank_fee_row


# ---------- Digit-density gate ----------------------------------------

def test_more_than_three_digits_is_noisy():
    assert looks_noisy("39763343 TRAN FEE 5247719998897619215986202")
    assert looks_noisy("50292203 TRAN FEE 5247719998897619215986202")
    assert looks_noisy("110 Nov. 21 350.00 111 Nov. 24 378.00")
    assert looks_noisy("Deposit 12345 67890")
    assert looks_noisy("Some Vendor 12345")


def test_three_or_fewer_digits_is_fine():
    assert not looks_noisy("Starbucks")
    assert not looks_noisy("AT&T")
    assert not looks_noisy("7-Eleven")
    assert not looks_noisy("IKEA")
    assert not looks_noisy("GTM 3.0")


def test_high_digit_density_short_string_is_noisy():
    assert looks_noisy("72075183TRAN")           # 8+ chars, >30% digits
    assert looks_noisy("4567 89 Test")            # 8+ chars, digit-heavy


# ---------- Bank-fee vocabulary --------------------------------------

def test_bank_fee_vocab_is_noisy_and_marked_fee_row():
    fee_memos = [
        "TRAN FEE 5247719998897619215986202",
        "SERVICE CHARGE",
        "Monthly Maintenance Fee",
        "NSF FEE",
        "Overdraft Fee",
        "Wire Fee",
        "Analysis Charge",
        "Internatl Tx Fee COZUMEL",
        "Foreign Transaction Fee",
        "Interest Paid",
        "Finance Charge",
    ]
    for m in fee_memos:
        assert is_bank_fee_row(m), f"expected is_bank_fee_row({m!r})"
        assert looks_noisy(m), f"expected looks_noisy({m!r})"


def test_non_fee_memos_are_not_fee_rows():
    for m in ("Starbucks", "COSTCO WHSE", "PAYPAL Susan", "Amazon Prime"):
        assert not is_bank_fee_row(m), f"unexpected fee-row match: {m!r}"


# ---------- Check-register OCR ---------------------------------------

def test_check_register_ocr_row_is_noisy():
    assert looks_noisy("128 Dec. 24 187.00 129 Jan. 04 234.00")
    assert looks_noisy("110 Nov. 21 350.00")           # single row
    assert looks_noisy("155 Mar. 02 450.00 164 Mar. 25 450.00")


# ---------- Preserve existing behavior --------------------------------

def test_zelle_venmo_still_noisy():
    assert looks_noisy("Zelle")
    assert looks_noisy("Venmo")
    assert looks_noisy("Zelle Andrew Chesnutt ZELLE DEBIT")


def test_long_memo_still_noisy():
    assert looks_noisy("A" * 46)


def test_empty_and_none_never_noisy():
    assert not looks_noisy("")
    assert not looks_noisy(None)
    assert not is_bank_fee_row("")
    assert not is_bank_fee_row(None)
