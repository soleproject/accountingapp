"""Cockpit — phase derivation + close score unit tests.

Cockpit's Close Board sorts every client into one of 7 phases based on
the underlying month-close checkpoint state + open client-portal
requests. These pure-logic helpers must be locked in so a refactor of
month_close.py doesn't silently reshuffle the kanban.
"""
from routes.cockpit import (
    _derive_phase, _phase_pct, _close_score, PHASES,
)


def _status(**cps):
    """Build a status dict with green + counts explicitly set per checkpoint."""
    default = {
        "txns_reviewed": {"green": False, "total": 100, "uncategorized": 0, "unreviewed": 0},
        "invoices":      {"green": False, "outstanding": 0, "auto": False},
        "bills":         {"green": False, "outstanding": 0, "auto": False},
        "recon":         {"green": False, "total": 10, "cleared": 0, "auto": False},
        "closed":        {"green": False},
    }
    for k, v in cps.items():
        default[k] = {**default[k], **v}
    return {"checkpoints": default}


def test_phase_closed_wins_over_everything():
    s = _status(closed={"green": True})
    assert _derive_phase(s, portal_pending=5) == "closed"


def test_phase_not_started_when_no_txns():
    s = _status(txns_reviewed={"green": True, "total": 0})
    assert _derive_phase(s, portal_pending=0) == "not_started"


def test_phase_cleanup_when_txns_not_reviewed():
    s = _status(txns_reviewed={"green": False, "total": 100, "unreviewed": 20})
    assert _derive_phase(s, portal_pending=0) == "cleanup"


def test_phase_reconciling_when_recon_not_green():
    s = _status(
        txns_reviewed={"green": True, "total": 100, "unreviewed": 0},
        recon={"green": False, "total": 10, "cleared": 5},
    )
    assert _derive_phase(s, portal_pending=0) == "reconciling"


def test_phase_adjusting_after_cleanup_and_recon():
    s = _status(
        txns_reviewed={"green": True, "total": 100, "unreviewed": 0},
        recon={"green": True, "total": 10, "cleared": 10},
        invoices={"green": False, "outstanding": 3},
    )
    # No portal wait → adjusting (Phase 1 semantic — becomes real AI JE
    # drafters in Phase 3, but board placement is stable today).
    assert _derive_phase(s, portal_pending=0) == "adjusting"


def test_phase_client_review_when_portal_pending():
    s = _status(
        txns_reviewed={"green": True, "total": 100, "unreviewed": 0},
        recon={"green": True, "total": 10, "cleared": 10},
    )
    assert _derive_phase(s, portal_pending=3) == "client_review"


def test_phase_ready_to_close_when_all_green():
    s = _status(
        txns_reviewed={"green": True, "total": 100},
        recon={"green": True, "total": 10, "cleared": 10},
        invoices={"green": True},
        bills={"green": True},
    )
    assert _derive_phase(s, portal_pending=0) == "ready_to_close"


def test_phase_pct_all_five():
    s = _status(
        txns_reviewed={"green": True}, invoices={"green": True},
        bills={"green": True}, recon={"green": True}, closed={"green": True},
    )
    assert _phase_pct(s) == 100


def test_phase_pct_pre_close_only():
    s = _status(
        txns_reviewed={"green": True}, invoices={"green": True},
        bills={"green": True}, recon={"green": True},  # 4/5 = 80
    )
    assert _phase_pct(s) == 80


def test_close_score_all_green_no_portal():
    s = _status(
        txns_reviewed={"green": True, "total": 100, "unreviewed": 0, "uncategorized": 0},
        recon={"green": True, "total": 10, "cleared": 10},
        invoices={"green": True},
        bills={"green": True},
    )
    # 25 cleanup + 25 recon + 10 inv + 10 bills + 10 client + 15 adjust
    # + 5 anomaly = 100
    assert _close_score(s, portal_pending=0, anomaly_count=0) == 100


def test_close_score_penalizes_portal_wait_and_anomalies():
    s = _status(
        txns_reviewed={"green": True, "total": 100, "unreviewed": 0, "uncategorized": 0},
        recon={"green": True, "total": 10, "cleared": 10},
        invoices={"green": True},
        bills={"green": True},
    )
    # 10 - (2*3) = 4 client pts; -3 anomaly pts (5 - min(5,3))
    got = _close_score(s, portal_pending=3, anomaly_count=3)
    assert got < 100
    assert got >= 60  # Still solidly amber
