"""Regression tests for the whitespace-tolerant company-delete confirm.

Scenario that motivated this: on prod, "QBO 14 LLC" would not delete
because the stored name contained non-breaking spaces (U+00A0) between
words, but the operator typed regular spaces (U+0020) on their
keyboard. The strict `!=` comparison rejected them even though the
name was visually identical.

Fix: normalize both sides — collapse any run of whitespace to a single
ASCII space, then trim — before comparing. Same helper runs on the
frontend (`normName` in CompanySettings.jsx).
"""
from __future__ import annotations

from routes.companies import _norm_name


def test_norm_name_collapses_non_breaking_spaces():
    """The exact case that hit prod: NBSPs between words."""
    stored = "QBO\u00a014\u00a0LLC"
    typed = "QBO 14 LLC"
    assert _norm_name(stored) == _norm_name(typed) == "QBO 14 LLC"


def test_norm_name_collapses_double_regular_spaces():
    """Copy-paste from a rich-text field often introduces double
    spaces that the confirm dialog then displays unchanged."""
    assert _norm_name("QBO  14  LLC") == _norm_name("QBO 14 LLC")


def test_norm_name_trims_leading_and_trailing_whitespace():
    assert _norm_name("  Widgets Co ") == _norm_name("Widgets Co")
    assert _norm_name("\u00a0Widgets Co\u00a0") == "Widgets Co"


def test_norm_name_collapses_mixed_whitespace_run():
    """A tab + NBSP + space combo (worst-case mangled paste) still
    canonicalizes to a single-space form."""
    assert _norm_name("A\t\u00a0 B") == "A B"


def test_norm_name_preserves_non_whitespace_differences():
    """Whitespace forgiveness must NOT let a real name mismatch through
    — this is the safety gate that keeps the confirm meaningful."""
    assert _norm_name("Widgets Co") != _norm_name("Widgets Inc")
    assert _norm_name("Widgets Co") != _norm_name("widgets co")
    assert _norm_name("QBO 14 LLC") != _norm_name("QBO 14")


def test_norm_name_handles_none_and_empty():
    assert _norm_name(None) == ""
    assert _norm_name("") == ""
    assert _norm_name("   ") == ""
