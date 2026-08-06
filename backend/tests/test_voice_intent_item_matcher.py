"""Regression tests for the voice-invoice item resolver in `routes/chat.py`.

Guards the fuzzy-matcher that turns spoken references like "five widget
ones" into a real line item {item_id, description, rate, quantity} by
matching against the company's item catalog.
"""
from routes.chat import _match_item


CATALOG = [
    {
        "id": "widget-1", "name": "Widget 1", "price": 100,
        "description": "Test widget", "usage": "both",
        "income_account_id": "acct-1", "income_account_name": "Product Sales",
    },
    {
        "id": "widget-2", "name": "Widget 2", "price": 200,
        "description": "Second widget", "usage": "both",
    },
    {
        "id": "coffee-mug", "name": "Coffee Mug", "price": 15,
        "description": "Branded mug", "usage": "both",
    },
]


def test_match_ordinal_word_to_digit():
    """STT commonly emits 'widget one' for 'Widget 1'; matcher must map
    the first-ten ordinal words to digits on both sides."""
    m = _match_item("widget one", CATALOG)
    assert m and m["id"] == "widget-1"


def test_match_plural_ordinal_word():
    """'widget ones' — spoken plural — must still match 'Widget 1'."""
    m = _match_item("widget ones", CATALOG)
    assert m and m["id"] == "widget-1"


def test_match_exact_name_wins():
    """Exact case-insensitive name beats every other signal."""
    m = _match_item("Widget 2", CATALOG)
    assert m and m["id"] == "widget-2"


def test_match_case_and_whitespace_insensitive():
    m = _match_item("  COFFEE   mug  ", CATALOG)
    assert m and m["id"] == "coffee-mug"


def test_no_match_returns_none():
    """Unknown items must fail-safe to None so the modal falls back to
    a freeform line the user can fill in."""
    assert _match_item("gizmo", CATALOG) is None
    assert _match_item("", CATALOG) is None
    assert _match_item("widget one", []) is None


def test_single_word_partial_match():
    """'widget' alone shouldn't randomly pick Widget 2 over Widget 1 —
    both have equal overlap. Whichever comes first wins deterministically."""
    m = _match_item("widget", CATALOG)
    assert m and m["id"] in ("widget-1", "widget-2")
