"""Emergent Object Storage — thin wrapper the rest of the backend
imports from. One shared `storage_key` is initialized at startup;
downstream helpers reuse it. Failures are non-fatal at startup
(the app still boots, uploads just 503 with a clear error).

Path convention: `smartbooks/<company_id>/<uuid>.<ext>` — one
bucket-per-account isolation is handled by the proxy.
"""
from __future__ import annotations
import os
import logging
from typing import Optional

import requests

logger = logging.getLogger("axiom.storage")

APP_NAME = "smartbooks"
STORAGE_BASE = (os.environ.get("INTEGRATION_PROXY_URL") or "").strip() \
    or "https://integrations.emergentagent.com"
STORAGE_URL = STORAGE_BASE.rstrip("/") + "/objstore/api/v1/storage"

_storage_key: Optional[str] = None


class StorageUnavailable(RuntimeError):
    """Raised when object storage isn't reachable / initialized."""


def init_storage(force: bool = False) -> str:
    """Mint (or return cached) session `storage_key`. Call once at
    startup — subsequent callers reuse the cached value. `force`
    bypasses the cache after a `404 storage_key unknown` bounce."""
    global _storage_key
    if _storage_key and not force:
        return _storage_key
    key = os.environ.get("EMERGENT_LLM_KEY")
    if not key:
        raise StorageUnavailable("EMERGENT_LLM_KEY not set")
    resp = requests.post(f"{STORAGE_URL}/init", json={"emergent_key": key}, timeout=30)
    if resp.status_code >= 400:
        raise StorageUnavailable(f"storage init HTTP {resp.status_code}: {resp.text[:200]}")
    _storage_key = resp.json()["storage_key"]
    return _storage_key


def put_object(path: str, data: bytes, content_type: str) -> dict:
    """Upload bytes. Returns `{path, size, etag}` from the proxy —
    always persist `result["path"]` as the canonical identifier."""
    try:
        key = init_storage()
    except StorageUnavailable:
        raise
    resp = requests.put(
        f"{STORAGE_URL}/objects/{path}",
        headers={"X-Storage-Key": key, "Content-Type": content_type},
        data=data, timeout=120,
    )
    if resp.status_code == 404:
        # Cached storage_key went cold — refresh once and retry.
        key = init_storage(force=True)
        resp = requests.put(
            f"{STORAGE_URL}/objects/{path}",
            headers={"X-Storage-Key": key, "Content-Type": content_type},
            data=data, timeout=120,
        )
    if resp.status_code >= 400:
        raise StorageUnavailable(f"put HTTP {resp.status_code}: {resp.text[:200]}")
    return resp.json()


def get_object(path: str) -> tuple[bytes, str]:
    """Download bytes. Returns `(content, content_type)`."""
    key = init_storage()
    resp = requests.get(
        f"{STORAGE_URL}/objects/{path}",
        headers={"X-Storage-Key": key}, timeout=60,
    )
    if resp.status_code == 404:
        key = init_storage(force=True)
        resp = requests.get(
            f"{STORAGE_URL}/objects/{path}",
            headers={"X-Storage-Key": key}, timeout=60,
        )
    if resp.status_code >= 400:
        raise StorageUnavailable(f"get HTTP {resp.status_code}: {resp.text[:200]}")
    return resp.content, resp.headers.get("Content-Type", "application/octet-stream")
