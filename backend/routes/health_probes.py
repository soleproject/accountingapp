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
from infra import get_cache

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


