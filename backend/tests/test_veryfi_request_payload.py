"""Veryfi request-payload wire format tests.

Verifies `process_bank_statement` sends the `categories` list from
`veryfi_categories.BANK_STATEMENT_CATEGORIES` via Veryfi's JSON body
path — base64 `file_data` + native JSON `categories` array. This
matches the shape Veryfi's own Python SDK
(`veryfi/bank_statements.py::process_bank_statement_document`) sends,
which is the guaranteed-compatible transport.

Prior bug (Feb 2026): a brief attempt used repeated multipart form
fields (`[("categories", "a"), ("categories", "b"), ...]`) — Veryfi's
Cloudflare-fronted origin returned 520/521 on every upload since
their multipart parser doesn't handle the repeated-field convention.

Patches `httpx.AsyncClient.post` in-place so the test is fully offline
and safe to run in CI.
"""
from __future__ import annotations
import os
import sys
import base64
import asyncio
from unittest.mock import patch

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME", "VERYFI_CLIENT_ID", "VERYFI_USERNAME", "VERYFI_API_KEY"):
    if k in _env:
        os.environ.setdefault(k, _env[k].strip('"'))

import veryfi_service                                    # noqa: E402
from veryfi_categories import BANK_STATEMENT_CATEGORIES  # noqa: E402


def _make_response(status: int, payload: dict):
    """Minimal `httpx.Response`-shaped stub for our call site."""
    class _R:
        status_code = status
        text = ""
        def json(self):
            return payload
        def raise_for_status(self):
            if status >= 400:
                raise RuntimeError(f"HTTP {status}")
    return _R()


def test_categories_sent_as_json_array_via_json_body():
    """The `categories` field must be a native JSON list in the
    request body — NOT a JSON-encoded string, NOT repeated
    multipart parts. Matches Veryfi's SDK exactly.
    """
    calls: list[dict] = []
    fake_pdf = b"%PDF-1.4\n% fake\n%%EOF\n"

    async def fake_post(self, url, **kwargs):
        calls.append({"url": url, **kwargs})
        return _make_response(201, {"id": 1, "accounts": [], "transactions": []})

    async def run():
        with patch("httpx.AsyncClient.post", new=fake_post):
            return await veryfi_service.process_bank_statement(
                fake_pdf, "statement.pdf", "application/pdf",
            )

    result = asyncio.run(run())
    assert result == {"id": 1, "accounts": [], "transactions": []}

    assert len(calls) == 1, "expected exactly one Veryfi POST"
    call = calls[0]
    # No multipart `files=` — we're on the JSON path now.
    assert call.get("files") is None, "should not send multipart files"
    # Payload must be under `json=` (httpx auto-serializes + sets header).
    payload = call.get("json")
    assert isinstance(payload, dict), f"expected json payload, got {type(payload).__name__}"
    # Native list, not a JSON-encoded string
    assert payload["categories"] == BANK_STATEMENT_CATEGORIES
    assert isinstance(payload["categories"], list)
    # File must be base64-encoded
    assert payload["file_name"] == "statement.pdf"
    assert isinstance(payload["file_data"], str)
    assert base64.b64decode(payload["file_data"]) == fake_pdf
    # Content-Type must be JSON — inherited from httpx's json= handling
    ct = call["headers"].get("Content-Type")
    assert ct == "application/json", f"unexpected content-type: {ct}"


def test_fallback_to_documents_endpoint_on_4xx():
    """If /bank-statements/ returns 4xx (account doesn't have the
    product enabled, bad payload, etc.), fall back to /documents/
    so the ingest never fully fails."""
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
    test_categories_sent_as_json_array_via_json_body()
    print("OK: test_categories_sent_as_json_array_via_json_body")
    test_fallback_to_documents_endpoint_on_4xx()
    print("OK: test_fallback_to_documents_endpoint_on_4xx")
