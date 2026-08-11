"""Regression tests for the audit trail (added Feb 2026).

Covers:
  * `diff_docs` — deep field diff produces the {field: [old, new]} shape
  * `_redact` — password/token fields are masked before storage
  * `_compress`/`_decompress` — round-trip of typical dicts
  * `_needs_snapshot` policy — deletes + config entities always store
    the full snapshot; regular updates store a diff-only record
  * `hydrate_event` — decompresses stored blobs and derives a diff for
    full-snapshot events so the API response is a consistent shape
"""
import pytest

import audit


def test_diff_docs_captures_changes_only():
    before = {"amount": 100, "memo": "A", "notes": "same"}
    after = {"amount": 120, "memo": "B", "notes": "same"}
    d = audit.diff_docs(before, after)
    assert d == {"amount": [100, 120], "memo": ["A", "B"]}


def test_diff_docs_handles_missing_sides():
    # Field only in `after` (create scenario)
    assert audit.diff_docs({}, {"x": 1}) == {"x": [None, 1]}
    # Field only in `before` (delete scenario)
    assert audit.diff_docs({"x": 1}, {}) == {"x": [1, None]}
    # Both None
    assert audit.diff_docs(None, None) == {}


def test_redact_masks_sensitive_fields():
    doc = {
        "email": "u@x.com",
        "password": "hunter2",
        "password_hash": "argon2:...",
        "access_token": "sk-live-abc",
        "nested": {"api_key": "secret"},
        "list": [{"webhook_secret": "shh"}],
    }
    red = audit._redact(doc)
    # Non-sensitive fields survive
    assert red["email"] == "u@x.com"
    # Every sensitive field is masked at every depth
    assert red["password"] == "«redacted»"
    assert red["password_hash"] == "«redacted»"
    assert red["access_token"] == "«redacted»"
    assert red["nested"]["api_key"] == "«redacted»"
    assert red["list"][0]["webhook_secret"] == "«redacted»"


def test_compress_decompress_roundtrip():
    doc = {"a": 1, "b": "hello", "c": [1, 2, 3], "d": {"e": None}}
    z = audit._compress(doc)
    assert isinstance(z, bytes)
    assert len(z) > 0
    assert audit._decompress(z) == doc
    # None-in / None-out
    assert audit._compress(None) is None
    assert audit._decompress(None) is None


def test_needs_snapshot_policy():
    # Deletes always snapshot regardless of entity type
    assert audit._needs_snapshot(audit.EVENT_DELETE, "transaction") is True
    # Auth events always snapshot
    assert audit._needs_snapshot(audit.EVENT_LOGIN, None) is True
    assert audit._needs_snapshot(audit.EVENT_IMPERSONATE_START, "user") is True
    # Config-shaped entities: any update is a snapshot
    assert audit._needs_snapshot(audit.EVENT_UPDATE, "company") is True
    assert audit._needs_snapshot(audit.EVENT_UPDATE, "account") is True
    assert audit._needs_snapshot(audit.EVENT_UPDATE, "tax_rate") is True
    # Regular high-volume entities: diff-only
    assert audit._needs_snapshot(audit.EVENT_UPDATE, "transaction") is False
    assert audit._needs_snapshot(audit.EVENT_UPDATE, "invoice") is False


def test_hydrate_derives_diff_for_full_snapshot_events():
    """When an event was stored with before + after (full snapshot) but
    no explicit diff blob, `hydrate_event` computes the diff on read
    so the API response is always shape-consistent for the UI."""
    before_z = audit._compress({"phone": "111", "email": "a@x"})
    after_z  = audit._compress({"phone": "222", "email": "a@x"})
    row = {
        "id": "x", "event_type": "update", "entity_type": "company",
        "before_z": before_z, "after_z": after_z, "diff_z": None,
    }
    hy = audit.hydrate_event(row)
    assert hy["diff"] == {"phone": ["111", "222"]}
    # `_z` fields stripped from output
    assert "before_z" not in hy
    assert "after_z" not in hy
    # Decompressed views present
    assert hy["before"] == {"phone": "111", "email": "a@x"}
    assert hy["after"]  == {"phone": "222", "email": "a@x"}


def test_hydrate_uses_stored_diff_for_diff_only_events():
    """Regular updates store a compact diff-only record. The stored
    diff is what the UI shows; we never re-derive it from before/after
    (which would be None on this shape)."""
    diff_z = audit._compress({"amount": [100, 120]})
    row = {
        "id": "y", "event_type": "update", "entity_type": "transaction",
        "before_z": None, "after_z": None, "diff_z": diff_z,
    }
    hy = audit.hydrate_event(row)
    assert hy["diff"] == {"amount": [100, 120]}
    assert hy["before"] is None
    assert hy["after"] is None


def test_diff_ignores_redacted_key_equality():
    """Two `{password: 'foo'}` and `{password: 'bar'}` docs both redact
    to `{password: '«redacted»'}` — so the diff sees them as equal and
    doesn't leak the fact that the password changed. This is
    intentional: an audit consumer never needs (or should get) any
    signal on password contents."""
    d = audit.diff_docs({"password": "hunter2", "email": "a@x"},
                        {"password": "hunter3", "email": "a@x"})
    assert d == {}
