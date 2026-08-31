"""Veryfi request-payload wire format tests.

Verifies that when we call `process_bank_statement`, the `categories`
list from `veryfi_categories.BANK_STATEMENT_CATEGORIES` is transmitted
as REPEATED multipart form fields — the correct convention for a
`string[]` body param per Veryfi's OpenAPI spec.

Prior bug (Feb 2026): categories were JSON-encoded into a single form
field (`categories='["a","b"]'`), which the Veryfi server treated as a
string, not a list — silently ignoring the custom category taxonomy.

Patches `httpx.AsyncClient.post` in-place so the test is fully offline
and safe to run in CI.
"""
from __future__ import annotations
import os
import sys
import asyncio
from unittest.mock import AsyncMock, patch

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME", "VERYFI_CLIENT_ID", "VERYFI_USERNAME", "VERYFI_API_KEY"):
    if k in _env:
        os.environ.setdefault(k, _env[k].strip('"'))

import veryfi_service                                    # noqa: E402
from veryfi_categories import BANK_STATEMENT_CATEGORIES  # noqa: E402


def _make_response(status: int, payload: dict):
    """Build a minimal object shaped like `httpx.Response` for our
    call site (only .status_code, .json(), .raise_for_status() are read)."""
    class _R:
        status_code = status
        text = ""
        def json(self):
            return payload
        def raise_for_status(self):
            if status >= 400:
                raise RuntimeError(f"HTTP {status}")
    return _R()


def test_categories_sent_as_repeated_multipart_fields():
    """Every entry in BANK_STATEMENT_CATEGORIES must be passed to
    httpx as its own `("categories", <name>)` tuple — NOT collapsed
    into a single JSON-encoded string. httpx serializes a
    list-of-tuples `data=` into the correct repeated-field multipart.
    """
    calls: list[dict] = []

    async def fake_post(self, url, **kwargs):
        calls.append({"url": url, **kwargs})
        return _make_response(201, {"id": 1, "accounts": [], "transactions": []})

    async def run():
        with patch("httpx.AsyncClient.post", new=fake_post):
            return await veryfi_service.process_bank_statement(
                b"%PDF-1.4\n% fake\n%%EOF\n", "statement.pdf", "application/pdf",
            )

    result = asyncio.run(run())
    assert result == {"id": 1, "accounts": [], "transactions": []}

    assert len(calls) == 1, "expected exactly one Veryfi POST"
    data = calls[0]["data"]
    # Payload MUST be a list of ("categories", <str>) tuples.
    assert isinstance(data, list), f"expected list, got {type(data).__name__}"
    field_names = {name for name, _ in data}
    assert field_names == {"categories"}, f"unexpected field names: {field_names}"
    values = [v for _, v in data]
    # Order-preserving check: exact same list, exact same order.
    assert values == BANK_STATEMENT_CATEGORIES, (
        "categories payload doesn't match BANK_STATEMENT_CATEGORIES"
    )
    # Guard against the pre-fix regression: single field with a JSON
    # array value like '["a","b"]'.
    assert not any(v.startswith("[") and v.endswith("]") for v in values), (
        "found a bracket-wrapped value — categories were JSON-encoded "
        "into a single field again (pre-fix regression)"
    )


def test_fallback_to_documents_endpoint_on_4xx():
    """If /bank-statements/ returns 4xx (account doesn't have the
    product enabled), fall back to /documents/. Regression guard
    for our graceful-degradation contract."""
    calls: list[str] = []

    async def fake_post(self, url, **kwargs):
        calls.append(url)
        if "bank-statements" in url:
            return _make_response(400, {"error": "bad request"})
        return _make_response(201, {"id": 42, "line_items": []})

    async def run():
        with patch("httpx.AsyncClient.post", new=fake_post):
            return await veryfi_service.process_bank_statement(
                b"%PDF-1.4\n% fake\n%%EOF\n", "statement.pdf", "application/pdf",
            )

    result = asyncio.run(run())
    assert result["id"] == 42
    assert any("bank-statements" in u for u in calls)
    assert any("documents" in u for u in calls)


if __name__ == "__main__":
    test_categories_sent_as_repeated_multipart_fields()
    print("OK: test_categories_sent_as_repeated_multipart_fields")
    test_fallback_to_documents_endpoint_on_4xx()
    print("OK: test_fallback_to_documents_endpoint_on_4xx")
