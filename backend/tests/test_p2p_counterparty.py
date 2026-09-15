"""Regression tests for P2P counterparty extraction and placeholder
rejection — the Feb 2026 fix that made the Contact Pairing Auditor
stop suggesting garbage names like "Individual Payment" / "Unnamed
Individual" for Venmo/Zelle rows we can't resolve."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contact_resolver import (
    extract_p2p_counterparty,
    _P2P_PAYMENT_APPS,
    _INDN_RX,
    _ZELLE_RX,
    _VENMO_RX,
    _CASHAPP_RX,
)
from contact_auditor import _is_placeholder_canonical


# --------------------------------------------------------------------------
# P2P counterparty extraction — Plaid Enrichment v2 first, then regex over
# original_description / description.
# --------------------------------------------------------------------------

def test_counterparties_enrichment_picks_non_payment_app():
    """When Plaid Enrichment v2 returns counterparties[], the FIRST
    non-payment_app entry is the real recipient."""
    cps = [
        {"name": "Venmo", "type": "payment_app"},
        {"name": "Jane Doe", "type": "merchant"},
    ]
    assert extract_p2p_counterparty("Venmo", "Venmo", None, cps) == "Jane Doe"


def test_counterparties_skips_all_payment_apps():
    """When every counterparty is a payment_app we get no name (rather
    than returning "Venmo" as if it were the recipient)."""
    cps = [{"name": "Venmo", "type": "payment_app"}]
    assert extract_p2p_counterparty("Venmo", "Venmo", None, cps) is None


def test_indn_extraction_from_original_description():
    """The classic ACH `INDN:<person>` pattern."""
    orig = "VENMO PAYMENT DES:PAYMENT ID:XXXXXXXXX INDN:JANE M DOE CO ID:VENMOACHXXX PPD"
    assert extract_p2p_counterparty("Venmo", "Venmo", orig, None) == "Jane M Doe"


def test_zelle_payment_to_extraction():
    orig = "Zelle payment to Kevin Petersen Conf#123456"
    assert extract_p2p_counterparty("Zelle", "Zelle", orig, None) == "Kevin Petersen"


def test_zelle_payment_from_extraction():
    orig = "Zelle payment from Romeo Ugali Conf#123456"
    assert extract_p2p_counterparty("Zelle", "Zelle", orig, None) == "Romeo Ugali"


def test_venmo_debit_asterisk_extraction():
    """Venmo debit-card rows: `VENMO *KevinPetersen`."""
    orig = "VENMO *Kevin Petersen  06/15"
    assert extract_p2p_counterparty("Venmo", None, orig, None) == "Kevin Petersen"


def test_cashapp_asterisk_extraction():
    orig = "CASH APP*JANE DOE  05/12"
    assert extract_p2p_counterparty("Cash App", None, orig, None) == "Jane Doe"


def test_returns_none_when_memo_opaque():
    """The core fix: when we can't identify the recipient we return None,
    not a placeholder. Callers keep the generic "Venmo" contact instead
    of minting garbage."""
    assert extract_p2p_counterparty("Venmo", "Venmo", "", None) is None
    assert extract_p2p_counterparty("Venmo", "Venmo", "VENMO OUT", None) is None
    assert extract_p2p_counterparty("Zelle", "Zelle", "Zelle transfer 12345", None) is None


def test_rejects_placeholder_names_in_extraction():
    """If the memo somehow contains a placeholder word after INDN: we
    still refuse it — "Individual" identifies nothing."""
    orig = "ACH DEBIT DES:PAYMENT INDN:INDIVIDUAL CO ID:XXX PPD"
    assert extract_p2p_counterparty("ACH", None, orig, None) is None


def test_rejects_self_named_payment_app():
    """`VENMO PAYMENT INDN:VENMO` — the INDN happens to name the app.
    We don't want to promote the payment app to a contact — return None."""
    orig = "VENMO PAYMENT INDN:VENMO CO ID:XXX PPD"
    # `venmo` after normalization is in the P2P app set → rejected.
    assert extract_p2p_counterparty("Venmo", "Venmo", orig, None) is None


# --------------------------------------------------------------------------
# Placeholder canonical rejection in the auditor — the LLM sometimes
# proposes "Individual Payment" as a new-contact name; we refuse.
# --------------------------------------------------------------------------

def test_placeholder_canonical_rejected():
    for name in [
        "Individual",
        "individual",
        "Individual Payment",
        "Individual Person",
        "Unnamed Individual",
        "Unnamed",
        "Anonymous",
        "Generic Payer",
        "Generic Payee",
        "Unknown Customer",
        "Unknown Vendor",
        "Unspecified Vendor",
        "Unidentified Individual",
    ]:
        assert _is_placeholder_canonical(name), f"expected placeholder: {name!r}"


def test_real_names_not_rejected():
    for name in [
        "Kevin Petersen",
        "Jane Doe",
        "Amazon",
        "Costco",
        "AT&T",
        "Roblox",
        "Individual Inc.",  # tail-decorated business name
    ]:
        assert not _is_placeholder_canonical(name), f"expected NOT placeholder: {name!r}"


def test_empty_and_none_are_placeholders():
    """Empty / None counts as placeholder — same downstream behaviour
    (skip the finding)."""
    assert _is_placeholder_canonical(None)
    assert _is_placeholder_canonical("")


if __name__ == "__main__":
    import traceback
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
