"""Axiom Ledger — Health & readiness probes routes.

Auto-extracted from server.py during the Feb 2026 modularization refactor.
Behaviour is intentionally identical to the pre-split codebase.
"""
from __future__ import annotations
import os
import re
import uuid
import json
import random
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, Any, List

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, EmailStr, Field

from db import db, now_iso, coerce
from auth import (
    hash_password, verify_password, create_token,
    get_current_user, require_role,
)
from ai_service import (
    categorize_transaction, chat_stream, suggest_chart_of_accounts,
    onboarding_interview_questions, onboarding_interview_synthesize,
    parse_voice_intent,
)
import reports as R
import plaid_service
import plaid_connect
import veryfi_service
import merchant_cache
import contact_resolver
from infra import get_cache, cache_health

from models import (
    LoginIn, SignupIn, CompanyCreate, TransactionUpdate, TransactionCreate,
    SplitIn, RuleCreate, InvoiceCreate, BillCreate, ContactCreate,
    AccountCreate, JECreate, ChatIn, OnboardingUpdate, PaymentCreate,
    ReceiptCreate, GenericCreate, NewClientIn,
)
from deps import (
    DASH_CACHE_TTL,
    company_ids_for_user, require_company, log_ai,
    is_period_closed, assert_open,
    categorize_and_insert, sync_and_import,
)

router = APIRouter(prefix="/api")


# ----------------------- Health & readiness probes -----------------------

@router.get("/health")
async def health():
    """Liveness probe — cheap; only asserts the process is alive.
    Wired to the K8s livenessProbe on port 8001.
    """
    return {"status": "ok"}


@router.get("/ready")
async def ready():
    """Readiness probe — asserts Mongo is reachable AND our in-process
    task registry is populated. K8s uses this to decide whether to route
    traffic to the pod. Returning 503 while starting up prevents a client
    from hitting a pod before `sync_tasks.register_all()` has run.
    """
    from db import db as _db
    import job_queue as _jq
    try:
        await _db.command({"ping": 1})
    except Exception as e:  # noqa: BLE001
        return Response(
            content=json.dumps({"status": "unready", "reason": f"mongo: {e}"}),
            media_type="application/json", status_code=503,
        )
    if not _jq._TASK_REGISTRY:
        return Response(
            content=json.dumps({"status": "unready", "reason": "tasks not registered"}),
            media_type="application/json", status_code=503,
        )
    return {"status": "ready", "task_kinds": list(_jq._TASK_REGISTRY.keys())}


@router.get("/health/cache")
async def health_cache():
    """Expose the active cache backend so ops can confirm Redis is live
    without grepping logs. Response shape:

      { "backend": "redis"|"memory",
        "ok": bool,             // ping succeeded
        "ping_ms": float|null,
        "safe_for_multi_worker": bool,
        "redis_url_set": bool }

    `safe_for_multi_worker: false` is the loud alarm — it means we
    silently fell back to in-process, and any deploy with >1 uvicorn
    worker will serve stale reports on some fraction of requests.
    K8s can wire this to a critical alert.
    """
    info = await cache_health()
    # Return 200 always so a curl doesn't paper over 'safe_for_multi_worker=false'
    # by turning it into a red X. Ops read the JSON body, not the status.
    return info


@router.get("/health/multi-worker-round-trip")
async def health_multi_worker_round_trip():
    """Diagnostic used to prove that cache invalidation crosses worker
    boundaries. Round-trips a value through the cache backend:
      1. Write a key
      2. Read it back
      3. Invalidate
      4. Confirm it's gone

    If we're on the in-process backend this ALWAYS passes for the worker
    that received the request but proves NOTHING about the other workers.
    That's why the response also includes `caveat` so nobody reads a
    green here and thinks multi-worker is safe.
    """
    import uuid as _uuid
    c = get_cache()
    from infra import get_cache_backend
    backend = get_cache_backend()
    cid = f"__health__{_uuid.uuid4().hex[:8]}"
    # Namespaced key that carries `company_id=<cid>` so the standard
    # invalidate(company_id) matcher will find it, same as any real
    # report key would be shaped.
    key = c.key("health_probe", company_id=cid, probe=_uuid.uuid4().hex[:8])

    async def _compute_first():
        return {"probe": "first"}
    write = await c.get_or_compute(key, 60, _compute_first)

    read_marker = {"hit": False}
    async def _compute_should_not_run():
        read_marker["hit"] = True
        return {"probe": "recomputed"}
    read = await c.get_or_compute(key, 60, _compute_should_not_run)
    cache_hit = not read_marker["hit"]

    inv = await c.ainvalidate(cid)

    invalidated_marker = {"hit": False}
    async def _compute_after_invalidate():
        invalidated_marker["hit"] = True
        return {"probe": "regen"}
    after = await c.get_or_compute(key, 60, _compute_after_invalidate)
    invalidated = invalidated_marker["hit"]

    return {
        "backend": backend,
        "wrote": bool(write),
        "cache_hit_after_write": cache_hit,
        "invalidated_entries": inv,
        "recomputed_after_invalidate": invalidated,
        "all_green": cache_hit and invalidated,
        "caveat": (
            "Runs entirely inside ONE worker. On the in-process backend "
            "this passes but proves nothing about cross-worker invalidation. "
            "Only meaningful when backend=redis." if backend == "memory" else
            "Redis-backed — passing here means every worker will see the "
            "same invalidations."
        ),
    }


# ─── (Feb 2026) Thread + resource introspection ──────────────────────
#
# Purpose: give ops a way to answer "how many threads is this process
# holding right now?" without shell access to the Railway container.
# Prompted by a `RuntimeError: can't start new thread` incident where
# the container hit its pids_limit and login started 500-ing.
#
# Numbers we surface:
#   * `threading.active_count()` — total Python threads (main + all
#     daemon monitor threads + anyio pool + asyncio default executor).
#   * File descriptor count — a proxy for socket / connection leaks.
#   * RSS memory — a sanity check.
#   * The container's OS-level pids_max (RLIMIT_NPROC) — the ceiling.
#     When active_count approaches this, a thread-limit crash is
#     imminent. Set your alerting threshold to ~50% of nproc_max.
#
# Public (no auth) so a browser check works during an outage. Only
# leaks a per-process counter — nothing sensitive.

@router.get("/health/threads")
async def health_threads():
    import threading
    import resource
    out = {
        "python_thread_count": threading.active_count(),
        "python_thread_names": sorted(t.name for t in threading.enumerate())[:60],
    }
    try:
        # RLIMIT_NPROC is the per-user process/thread cap. On Linux
        # containers this maps to the effective PID limit for the
        # container. Report both soft (in-effect) and hard (max) so
        # we can tell whether the ceiling is negotiable.
        soft, hard = resource.getrlimit(resource.RLIMIT_NPROC)
        out["nproc_soft"] = soft
        out["nproc_hard"] = hard
    except Exception:  # noqa: BLE001
        pass
    try:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        # ru_maxrss is KB on Linux, bytes on macOS. Report both raw and
        # a MB-normalised value for quick human reading.
        out["max_rss_kb"] = usage.ru_maxrss
        out["max_rss_mb_approx"] = round(usage.ru_maxrss / 1024, 1)
    except Exception:  # noqa: BLE001
        pass
    try:
        # File descriptor count — a proxy for socket / connection leaks.
        # /proc/self/fd is Linux-only; wrapped so mac dev boxes don't
        # 500 the endpoint.
        import os as _os
        out["open_fd_count"] = len(_os.listdir("/proc/self/fd"))
    except Exception:  # noqa: BLE001
        pass
    return out




