"""Unit tests for the QBO private-label OAuth redirect helper.

Guarantees:
  1. Whitelisted `x-forwarded-host` yields the label's callback URL.
  2. Whitelisted `host` header (fallback) also works.
  3. `x-forwarded-host` takes precedence over `host` (matches Kubernetes
     ingress reality — the label host lives on `x-forwarded-host`).
  4. Non-whitelisted hosts return None (caller falls back to env default).
  5. Missing headers return None.
  6. Port suffix is stripped before whitelist match.
  7. Case-insensitive host comparison.
"""
from __future__ import annotations

from types import SimpleNamespace

from routes.qbo import _redirect_uri_from_request, _QBO_ALLOWED_HOSTS


def _mk_request(headers: dict[str, str]):
    """Minimal Request stand-in — only `.headers.get()` is exercised."""
    return SimpleNamespace(headers=headers)


def test_whitelisted_forwarded_host_yields_label_uri():
    r = _mk_request({"x-forwarded-host": "api.cypherpro.accountingapp.ai"})
    assert (
        _redirect_uri_from_request(r)
        == "https://api.cypherpro.accountingapp.ai/api/qbo/oauth/callback"
    )


def test_whitelisted_host_header_fallback():
    # No x-forwarded-host, only Host — should still resolve.
    r = _mk_request({"host": "api.smartbookssoftware.ai"})
    assert (
        _redirect_uri_from_request(r)
        == "https://api.smartbookssoftware.ai/api/qbo/oauth/callback"
    )


def test_forwarded_host_wins_over_host():
    r = _mk_request({
        "x-forwarded-host": "api.cypherpro.accountingapp.ai",
        "host": "api.smartbookssoftware.ai",
    })
    assert (
        _redirect_uri_from_request(r)
        == "https://api.cypherpro.accountingapp.ai/api/qbo/oauth/callback"
    )


def test_non_whitelisted_host_returns_none():
    r = _mk_request({"x-forwarded-host": "api.someoneelse.example.com"})
    assert _redirect_uri_from_request(r) is None


def test_missing_headers_returns_none():
    r = _mk_request({})
    assert _redirect_uri_from_request(r) is None


def test_port_suffix_is_stripped():
    # Some proxies pass host:port — the whitelist compare is host-only.
    r = _mk_request({"x-forwarded-host": "api.cypherpro.accountingapp.ai:8443"})
    assert (
        _redirect_uri_from_request(r)
        == "https://api.cypherpro.accountingapp.ai/api/qbo/oauth/callback"
    )


def test_case_insensitive_host_match():
    r = _mk_request({"x-forwarded-host": "API.CypherPro.AccountingApp.AI"})
    assert (
        _redirect_uri_from_request(r)
        == "https://api.cypherpro.accountingapp.ai/api/qbo/oauth/callback"
    )


def test_whitelist_contains_expected_hosts():
    # Sanity check — if we ever drop a host by accident the test flags it.
    assert "api.smartbookssoftware.ai" in _QBO_ALLOWED_HOSTS
    assert "api.cypherpro.accountingapp.ai" in _QBO_ALLOWED_HOSTS
