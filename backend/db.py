"""MongoDB helpers and base document utilities."""
from __future__ import annotations
import os
from pathlib import Path
from datetime import datetime, timezone
from typing import Annotated, Optional, Any
from bson import ObjectId
from dotenv import load_dotenv
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv(Path(__file__).parent / ".env")
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

_client = AsyncIOMotorClient(
    MONGO_URL,
    # Pool sized for 3k-user hardening: default is 100 which caps concurrent
    # Mongo ops per pod. At scale we run ~40 concurrent Plaid syncs plus
    # ~200 concurrent API requests → 200 conns leaves headroom for burst.
    # Override via env for even bigger pods.
    maxPoolSize=int(os.environ.get("MONGO_MAX_POOL_SIZE", "200")),
    minPoolSize=int(os.environ.get("MONGO_MIN_POOL_SIZE", "10")),
    serverSelectionTimeoutMS=5000,
)
db = _client[DB_NAME]


def _to_str(v: Any) -> str:
    if isinstance(v, ObjectId):
        return str(v)
    return str(v) if v is not None else v


PyObjectId = Annotated[str, BeforeValidator(_to_str)]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def coerce(doc: dict | None) -> dict | None:
    if not doc:
        return doc
    d = dict(doc)
    if "_id" in d:
        mongo_id = d.pop("_id")
        # Only use _id as id if the document doesn't already have its own id field
        if "id" not in d or d["id"] is None:
            d["id"] = str(mongo_id)
    return d


# ---------------------------------------------------------------------------
# Ledger transactions — atomic multi-doc writes
# ---------------------------------------------------------------------------
#
# Any code path that writes to more than one collection AND those writes
# together represent a single accounting truth (payment application, JE
# post + balance update, reconciliation clear, inventory receiving)
# MUST run under this helper. If the pod dies mid-way, either every
# write lands or none of them do — no more "phantom payment with an
# invoice still showing balance due" bugs.
#
# Design notes:
#   • Requires a replica-set Mongo. Atlas is one by default. LOCAL
#     `mongod --bind_ip_all` (preview) is NOT — so we gracefully fall
#     back to non-transactional execution and log a warning ONCE per
#     process. The warning surface makes it obvious in staging that
#     you'd be running without the guarantee in prod.
#   • Callers use `async with ledger_transaction() as session:` and
#     PASS `session=session` to every Mongo op inside.  Motor threads
#     the session through the wire protocol; forget it and the write
#     escapes the transaction silently.
#   • Read/write concern defaults to `snapshot` reads + `majority`
#     writes so a re-elected primary can't lose the transaction.

import logging as _logging
from contextlib import asynccontextmanager

_LEDGER_TXN_LOG = _logging.getLogger("axiom.ledger_txn")
_txn_supported: Optional[bool] = None  # tri-state: None=unknown, True/False


async def _probe_txn_support() -> bool:
    """One-time probe: try running a trivial write inside a transaction
    and see whether the driver rejects with 'Transaction numbers are
    only allowed on a replica set'. Cached per process.

    IMPORTANT: an empty transaction commits fine even on single-node
    mongod, so we MUST include a real write to catch non-replica-set
    deploys correctly. The write goes to a scratch collection and is
    aborted, never persisting.
    """
    global _txn_supported
    if _txn_supported is not None:
        return _txn_supported
    try:
        async with await _client.start_session() as s:
            async with s.start_transaction():
                # Real write inside — this is what actually surfaces the
                # 'Transaction numbers are only allowed on a replica set'
                # error on non-replica-set mongo. Abort before commit so
                # nothing lands on disk.
                await db._axiom_txn_probe.insert_one({"probe": 1}, session=s)
                raise _ProbeAbort()  # abort the transaction cleanly
    except _ProbeAbort:
        _txn_supported = True
    except Exception as e:  # noqa: BLE001
        _txn_supported = False
        _LEDGER_TXN_LOG.warning(
            "Mongo transactions unavailable in this deploy (%s). "
            "Multi-doc ledger writes will run WITHOUT atomicity — safe "
            "for preview but a correctness gap in production. Ensure "
            "your Mongo is a replica set.", e,
        )
    return _txn_supported


class _ProbeAbort(Exception):
    """Sentinel used by `_probe_txn_support` to cleanly abort the
    probe transaction without triggering the fallback path."""
    pass


@asynccontextmanager
async def ledger_transaction():
    """Atomic multi-doc write scope. Usage:

        async with ledger_transaction() as session:
            await db.payments.insert_one(doc, session=session)
            await db.invoices.update_one(..., session=session)
            await db.journal_entries.insert_one(je, session=session)

    If any write raises, ALL writes roll back. On non-replica-set
    Mongo (preview), the context manager yields `None` and callers
    proceed without transactional guarantees. Passing `session=None`
    to Motor is a no-op — safe.
    """
    if not await _probe_txn_support():
        yield None
        return
    async with await _client.start_session() as session:
        async with session.start_transaction():
            yield session


# ---------------------------------------------------------------------------
# insert_je — the ONE writer every JE call site should use
# ---------------------------------------------------------------------------
#
# Feb 2026 — historically, JE writers (inventory_service, asset_service,
# opening_balance_service, plaid_connect) each inserted their own doc
# and skipped the header `total_debit` / `total_credit` fields. Reports
# read from `lines[]` directly so it hasn't hit balance-sheet math, but
# any code reading the header saw 0 and got the wrong answer. This
# helper closes that gap and gives every JE writer a single choke point
# where cross-cutting concerns (audit fields, session propagation for
# transactions) land in one place.

import uuid as _uuid  # noqa: E402


async def insert_je(doc: dict, *, session=None) -> str:
    """Insert a journal_entries document with correctly computed header
    totals. Every JE writer in the app should route through here.

    Guarantees applied to `doc`:
      • `id` set if missing (uuid4)
      • `created_at` / `updated_at` set if missing
      • `total_debit` / `total_credit` recomputed from `lines[]` — this
        is the fix for the latent zero-header bug found by the Feb 2026
        ledger integrity check. Any values the caller pre-set are
        overwritten so lines and header can never disagree.

    Pass `session=` when running inside `ledger_transaction()` so the
    JE write joins the atomic scope. Callers outside a transaction pass
    `session=None` (the default), which Motor treats as a no-op.

    Returns the JE `id` so the caller can stamp it back on the parent
    (bill.je_id, invoice.je_id, etc.) inside the same transaction.
    """
    lines = doc.get("lines") or []
    d = round(sum(float(l.get("debit") or 0) for l in lines), 2)
    c = round(sum(float(l.get("credit") or 0) for l in lines), 2)
    if abs(d - c) > 0.005:
        # Cardinal double-entry violation — refuse to write rather than
        # let a bad JE land silently. The single-doc atomicity of insert
        # doesn't matter if the doc itself is broken.
        raise ValueError(
            f"JE would be unbalanced: debits={d} credits={c} diff={round(d-c,4)}"
        )
    doc.setdefault("id", str(_uuid.uuid4()))
    now = now_iso()
    doc.setdefault("created_at", now)
    doc["updated_at"] = now
    doc["total_debit"] = d
    doc["total_credit"] = c
    await db.journal_entries.insert_one(doc, session=session)
    return doc["id"]



class BaseDoc(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    id: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)
