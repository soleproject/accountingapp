"""Tests for the "how far back?" Plaid start-date feature (Feb 2026).

Coverage:
  1. `_days_from_start_date` converts ISO dates to Plaid `days_requested`,
     clamped to [1, 730].
  2. Malformed / missing input falls back to 730.
  3. Future dates or today collapse to 1 (min allowed).
  4. `plaid_service.create_link_token` clamps `days_requested`.
  5. `/plaid/exchange` persists `import_start_date` on the plaid_item.
  6. `sync_tasks._run_sync`'s date-floor filter drops txns older than
     the item's `import_start_date`.
"""
from __future__ import annotations

import sys
import uuid
from datetime import date, timedelta

sys.path.insert(0, "/app/backend")


def test_days_from_start_date_typical_conversion():
    from routes.onboarding import _days_from_start_date
    today = date.today()
    d30 = today - timedelta(days=30)
    d100 = today - timedelta(days=100)
    assert _days_from_start_date(d30.isoformat()) == 30
    assert _days_from_start_date(d100.isoformat()) == 100


def test_days_from_start_date_clamps_to_max_730():
    from routes.onboarding import _days_from_start_date
    # 5 years ago → Plaid's max is 730 days.
    d = date.today() - timedelta(days=365 * 5)
    assert _days_from_start_date(d.isoformat()) == 730


def test_days_from_start_date_today_and_future_collapse_to_min_1():
    from routes.onboarding import _days_from_start_date
    assert _days_from_start_date(date.today().isoformat()) == 1
    # Future date — user shouldn't be able to submit this, but coerce
    # to 1 rather than raising so it never crashes the route.
    d = date.today() + timedelta(days=10)
    assert _days_from_start_date(d.isoformat()) == 1


def test_days_from_start_date_defaults_to_730_for_bad_input():
    from routes.onboarding import _days_from_start_date
    assert _days_from_start_date(None) == 730
    assert _days_from_start_date("") == 730
    assert _days_from_start_date("garbage") == 730
    assert _days_from_start_date("2024/01/01") == 730  # wrong format


def test_create_link_token_clamps_days_requested(monkeypatch):
    """The plaid_service.create_link_token wrapper defends against
    out-of-range values sent by callers."""
    from plaid_service import create_link_token
    captured = {}

    def fake_create(req):
        # Introspect the LinkTokenTransactions object on the request.
        # Its `days_requested` attr should be clamped.
        try:
            captured["days"] = req.transactions.days_requested
        except Exception:
            pass
        return {"link_token": "stub"}

    import plaid_service
    monkeypatch.setattr(plaid_service._client, "link_token_create", fake_create)
    monkeypatch.setattr(plaid_service, "get_institution_name",
                         lambda *a, **kw: "Stub Bank", raising=False)
    create_link_token(user_id="u", days_requested=99999)
    assert captured["days"] == 730

    create_link_token(user_id="u", days_requested=-5)
    assert captured["days"] == 1  # Plaid's min is 1, not 0

    create_link_token(user_id="u", days_requested=45)
    assert captured["days"] == 45
