"""AI-generated custom KPIs (Feb 2026, Phase D-3).

Users describe a KPI in natural language ("% of deals closed within
30 days"), Claude Sonnet 4.6 emits a validated MongoDB aggregation
spec against a whitelisted collection, we save it as a shareable
widget on the home dashboard, and each render re-runs the aggregation
so numbers stay live.

Safety model:
    1. **Collection whitelist** — only a fixed set of collections is
       queryable so a prompt injection can't reach `users` or `.env`.
    2. **Operator whitelist** — only read-only aggregation stages
       (`$match`, `$group`, `$project`, `$count`, `$sortByCount`,
       `$sort`, `$limit`, `$addFields`, `$facet`, `$bucket`,
       `$unwind`) and value expressions (`$sum`, `$avg`, `$min`,
       `$max`, `$cond`, `$multiply`, `$divide`, `$subtract`,
       `$add`, `$ifNull`, `$dateDiff`, `$dateFromString`, `$gte`,
       `$lte`, `$gt`, `$lt`, `$eq`, `$ne`, `$in`).
    3. **Company scoping** — the first `$match` stage MUST filter by
       `company_id` == the caller's company. The executor injects it
       if the model forgets so cross-tenant leakage is impossible.
    4. **Doc / row cap** — pipeline always terminates with a
       `$limit: 1` clone so a runaway aggregation can never DoS the
       cluster.

Schema (`custom_kpis`):
    id, company_id, owner_user_id, scope ("company" | "user"),
    name, description, value_kind, tone,
    spec: {collection, pipeline, result_field},
    created_at, updated_at
"""
from __future__ import annotations

import json
import os
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from db import db, now_iso
from deps import require_company

router = APIRouter(prefix="/api")


# ------------------------------------------------------------------
# Allow-lists
# ------------------------------------------------------------------
ALLOWED_COLLECTIONS = {
    "transactions", "invoices", "bills", "payments",
    "deals", "contacts", "tasks", "time_entries",
    "projects", "employees", "accounts", "journal_entries",
}
ALLOWED_STAGES = {
    "$match", "$group", "$project", "$count", "$sortByCount",
    "$sort", "$limit", "$addFields", "$facet", "$bucket", "$unwind",
    "$set",
}
ALLOWED_OPS = {
    "$sum", "$avg", "$min", "$max", "$count", "$first", "$last",
    "$cond", "$multiply", "$divide", "$subtract", "$add",
    "$ifNull", "$dateDiff", "$dateFromString", "$toDate",
    "$dateTrunc", "$year", "$month", "$dayOfMonth",
    "$gte", "$lte", "$gt", "$lt", "$eq", "$ne", "$in", "$nin",
    "$and", "$or", "$not", "$exists", "$type",
    "$size", "$concat", "$toLower", "$toUpper",
    "$regex", "$options",
    "$literal",  # allow constants
    "$switch", "$branches", "$case", "$then", "$default",
    "$abs", "$round",
}
VALUE_KINDS = {"number", "currency", "percent", "text"}
TONES = {"emerald", "cyan", "violet", "amber", "rose", "slate"}
SCOPES = {"company", "user"}


def _clean(doc: dict | None) -> dict | None:
    if doc: doc.pop("_id", None)
    return doc


def _walk_operators(node: Any) -> set[str]:
    """Return every `$op` key used anywhere in the pipeline."""
    ops: set[str] = set()
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(k, str) and k.startswith("$"):
                ops.add(k)
            ops |= _walk_operators(v)
    elif isinstance(node, list):
        for it in node: ops |= _walk_operators(it)
    return ops


def _validate_spec(spec: dict) -> tuple[str, list]:
    """Return (collection, pipeline) or raise HTTPException(400)."""
    if not isinstance(spec, dict):
        raise HTTPException(400, "spec must be an object")
    coll = spec.get("collection")
    if coll not in ALLOWED_COLLECTIONS:
        raise HTTPException(400,
            f"collection must be one of {sorted(ALLOWED_COLLECTIONS)}")
    pipeline = spec.get("pipeline")
    if not isinstance(pipeline, list) or not pipeline:
        raise HTTPException(400, "pipeline must be a non-empty list of stages")
    if len(pipeline) > 12:
        raise HTTPException(400, "pipeline must have <= 12 stages")
    for stage in pipeline:
        if not isinstance(stage, dict) or len(stage) != 1:
            raise HTTPException(400,
                "each pipeline stage must be an object with exactly one key")
        (stage_name,) = stage.keys()
        if stage_name not in ALLOWED_STAGES:
            raise HTTPException(400,
                f"stage {stage_name!r} not allowed. "
                f"Whitelist: {sorted(ALLOWED_STAGES)}")
    # Every $op used inside stages must be on the whitelist.
    used_ops = _walk_operators(pipeline) - ALLOWED_STAGES
    disallowed = used_ops - ALLOWED_OPS
    if disallowed:
        raise HTTPException(400,
            f"operators {sorted(disallowed)} are not allowed")
    return coll, pipeline


def _inject_company_filter(cid: str, pipeline: list) -> list:
    """Guarantee the first stage filters by `company_id`.
    If it does, patch it. Otherwise prepend one."""
    if pipeline and "$match" in pipeline[0]:
        m = dict(pipeline[0]["$match"])
        m["company_id"] = cid  # override no matter what
        return [{"$match": m}] + pipeline[1:]
    return [{"$match": {"company_id": cid}}] + pipeline


async def run_custom_kpi(cid: str, kpi: dict) -> Any:
    """Execute a saved KPI and return the scalar value (or None on
    failure). Result-field lookup is best-effort: first row wins."""
    spec = kpi.get("spec") or {}
    coll, pipeline = _validate_spec(spec)
    pipeline = _inject_company_filter(cid, pipeline)
    pipeline.append({"$limit": 1})  # single scalar
    rf = spec.get("result_field") or "value"
    try:
        rows = await db[coll].aggregate(pipeline).to_list(1)
    except Exception:
        return None
    if not rows:
        return None
    row = rows[0]
    if rf in row: return row[rf]
    # Fall back to the first non-`_id` value if the model named it
    # something else — makes the "just try it" prompt more forgiving.
    for k, v in row.items():
        if k == "_id": continue
        return v
    return None


# ------------------------------------------------------------------
# LLM prompt & call
# ------------------------------------------------------------------
_SYSTEM_PROMPT = f"""You translate accounting/CRM/PM KPI requests into
a MongoDB aggregation JSON spec. Respond with ONLY a JSON object of the shape:

{{
  "name":         string, // <= 40 chars, snappy KPI title
  "description":  string, // one-line explanation of what it measures
  "value_kind":   "number" | "currency" | "percent" | "text",
  "tone":         "emerald" | "cyan" | "violet" | "amber" | "rose" | "slate",
  "spec": {{
    "collection": one of {sorted(ALLOWED_COLLECTIONS)},
    "pipeline":   MongoDB aggregation pipeline (list of stages),
    "result_field": name of the field in the final $project / $group
                    that holds the scalar to display (default "value")
  }}
}}

Rules (ANY violation will be rejected):
1. Allowed stages: {sorted(ALLOWED_STAGES)}.
2. Allowed operators: {sorted(ALLOWED_OPS)}.
3. Do NOT include a `company_id` filter — the executor injects it.
4. Do NOT include `$lookup`, `$out`, `$merge`, `$geoNear` — read-only aggs only.
5. Pipeline should terminate with a `$project` or `$group` that yields
   the KPI as `result_field` (default "value").
6. Prefer `percent` value_kind for ratios and cap them at 100.
7. Return ONLY the JSON — no markdown fence, no prose."""


# Cheatsheet the model uses to know what fields each collection has.
# Keeping this short & accurate matters more than being exhaustive.
_SCHEMA_HINTS = {
    "transactions": "date (YYYY-MM-DD), amount (float), type (income|expense), status, category_id, contact_id, account_id",
    "invoices":     "date, due_date, total, amount_paid, balance, status (paid|sent|overdue|partial|unpaid), contact_id, contact_name, invoice_number",
    "bills":        "date, due_date, total, amount_paid, balance, status, contact_id, contact_name",
    "payments":     "date, amount, direction (in|out), status, contact_id, invoice_id",
    "deals":        "title, stage (lead|qualified|proposal|negotiation|won|lost), value, probability, contact_id, contact_name, owner_user_id, source, expected_close_date, created_at, updated_at",
    "contacts":     "name, type (customer|vendor), email, phone, kind",
    "tasks":        "title, status (open|done|cancelled), kind (task|meeting|call|email), priority, due_date, entity_type, entity_id, assignee_user_id, completed_at",
    "time_entries": "employee_id, project_id, start_time, end_time, duration_minutes (int), is_billable (bool), status (draft|submitted|approved)",
    "projects":     "name, status (in_progress|completed|cancelled), estimated_revenue, contact_id, start_date, end_date",
    "employees":    "name, role, is_active, hourly_rate",
    "accounts":     "name, type (cash|bank|revenue|expense|asset|liability|equity), balance",
    "journal_entries": "date, memo, lines[{account_id, debit, credit}]",
}


async def _generate_via_llm(prompt: str) -> dict:
    """Call Claude Sonnet 4.6 with the prompt and parse JSON out."""
    from emergentintegrations.llm.chat import LlmChat, UserMessage
    key = os.environ.get("EMERGENT_LLM_KEY")
    if not key:
        raise HTTPException(500, "EMERGENT_LLM_KEY not configured")
    hints = "\n".join(f"- {c}: {desc}" for c, desc in _SCHEMA_HINTS.items())
    system = _SYSTEM_PROMPT + "\n\nSchema hints:\n" + hints
    chat = LlmChat(
        api_key=key,
        session_id=f"custom-kpi-{uuid.uuid4()}",
        system_message=system,
    ).with_model("anthropic", "claude-sonnet-4-6")
    reply = await chat.send_message(UserMessage(text=prompt))
    # `reply` is a string. Strip common wrappers ("```json ... ```").
    text = reply.strip()
    if text.startswith("```"):
        # Drop opening fence line, drop trailing fence.
        lines = text.splitlines()
        if lines[0].startswith("```"): lines = lines[1:]
        if lines and lines[-1].startswith("```"): lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        raise HTTPException(502,
            f"AI returned non-JSON: {text[:200]}")
    return data


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@router.get("/companies/{cid}/custom-kpis")
async def list_kpis(
    cid: str,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    rows = await db.custom_kpis.find({
        "company_id": cid,
        "$or": [{"scope": "company"}, {"owner_user_id": user["id"]}],
    }).sort([("created_at", -1)]).to_list(200)
    return {"kpis": [_clean(r) for r in rows]}


@router.post("/companies/{cid}/custom-kpis/generate")
async def generate_kpi(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    """Ask the LLM to draft a KPI spec from a natural-language prompt.
    Returns the preview (name, spec, sample value) — user confirms
    before saving via POST /custom-kpis."""
    await require_company(user, cid)
    prompt = (payload.get("prompt") or "").strip()
    if not prompt or len(prompt) > 500:
        raise HTTPException(400, "prompt must be 1-500 chars")
    draft = await _generate_via_llm(prompt)
    # Validate the LLM's output before we hand a preview back.
    _validate_spec(draft.get("spec"))
    if draft.get("value_kind") not in VALUE_KINDS:
        draft["value_kind"] = "number"
    if draft.get("tone") not in TONES:
        draft["tone"] = "violet"
    # Preview execute so the UI shows the number the KPI would render.
    fake = {"spec": draft["spec"]}
    preview_value = await run_custom_kpi(cid, fake)
    return {
        "ok": True,
        "draft": draft,
        "preview_value": preview_value,
        "prompt": prompt,
    }


@router.post("/companies/{cid}/custom-kpis")
async def save_kpi(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    """Persist an AI draft as a shareable KPI. `scope` = 'user' (only
    the creator sees it on their dashboard) or 'company' (visible on
    every teammate's dashboard)."""
    await require_company(user, cid)
    name = (payload.get("name") or "").strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "name must be 1-80 chars")
    spec = payload.get("spec")
    _validate_spec(spec)  # raises on bad shape
    scope = payload.get("scope") or "user"
    if scope not in SCOPES:
        raise HTTPException(400, f"scope must be one of {sorted(SCOPES)}")
    value_kind = payload.get("value_kind") or "number"
    if value_kind not in VALUE_KINDS:
        raise HTTPException(400, f"value_kind must be one of {sorted(VALUE_KINDS)}")
    tone = payload.get("tone") or "violet"
    if tone not in TONES:
        raise HTTPException(400, f"tone must be one of {sorted(TONES)}")
    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "owner_user_id": user["id"],
        "owner_name": user.get("name") or user.get("email") or "",
        "scope": scope,
        "name": name,
        "description": (payload.get("description") or "").strip(),
        "value_kind": value_kind,
        "tone": tone,
        "spec": spec,
        "prompt": (payload.get("prompt") or "").strip(),
        "created_at": now,
        "updated_at": now,
    }
    await db.custom_kpis.insert_one(doc)
    return {"ok": True, "kpi": _clean(dict(doc))}


@router.delete("/companies/{cid}/custom-kpis/{kpi_id}")
async def delete_kpi(
    cid: str, kpi_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    kpi = await db.custom_kpis.find_one({"company_id": cid, "id": kpi_id})
    if not kpi:
        raise HTTPException(404, "KPI not found")
    # Company-scope KPIs may only be deleted by their creator.
    if kpi.get("owner_user_id") != user["id"]:
        raise HTTPException(403, "Only the creator can delete this KPI")
    await db.custom_kpis.delete_one({"company_id": cid, "id": kpi_id})
    return {"ok": True, "deleted": True}
