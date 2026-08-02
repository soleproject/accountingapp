"""Insights Chat — a report-focused, chart-aware AI assistant that lives
in a floating widget (bottom-right of the app, à la Intercom / QBO's
Intuit Intelligence).

Deliberately SEPARATE from `AiPanel` (the big right-edge cockpit at
`/ai/chat/stream` + `/ai/parse-intent`). This one is scoped to a small
family of "tell me about this chart / show me this number" flows.

Design:
  • The LLM is given a *chart registry* (short natural-language index
    of every chart the app can render).
  • It picks the most relevant chart_id, chooses parameters, and returns
    a JSON envelope `{answer, chart_id?, chart_params?, quick_actions?}`.
  • The endpoint then runs the actual data-fetch itself (never trusting
    the LLM with raw numbers) and returns the answer + real chart data.
  • Cost-tracked via `feature="insights-chat"` on the LlmChat call.
"""
from __future__ import annotations
import json
import re
import uuid
from datetime import date, timedelta
from typing import Optional, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import get_current_user
from deps import require_company
from db import db, now_iso
from llm_client import LlmChat, UserMessage, TextDelta, StreamDone
from ai_service import MODEL_PROVIDER, MODEL_NAME

router = APIRouter(prefix="/api")


# ── Chart registry ───────────────────────────────────────────────────
# Every entry describes one first-class report/tile the widget can show.
# The `params_hint` block is what we pass into the LLM system prompt so
# it knows what arguments to ask for; `fetcher` is the actual server-
# side data-loader (never the LLM). Deliberately small — 6 to start,
# grows as we build.

async def _fetch_income_statement(cid: str, params: dict) -> dict:
    from reports import compute_income_statement
    start = params.get("start") or _default_period_start()
    end = params.get("end") or _today()
    basis = params.get("basis") or "accrual"
    return await compute_income_statement(cid, start=start, end=end, basis=basis)


async def _fetch_balance_sheet(cid: str, params: dict) -> dict:
    from reports import compute_balance_sheet
    as_of = params.get("as_of") or _today()
    basis = params.get("basis") or "accrual"
    return await compute_balance_sheet(cid, as_of=as_of, basis=basis)


async def _fetch_ar_aging(cid: str, params: dict) -> dict:
    from reports import compute_ar_aging
    as_of = params.get("as_of") or _today()
    return await compute_ar_aging(cid, as_of=as_of)


async def _fetch_ap_aging(cid: str, params: dict) -> dict:
    from reports import compute_ap_aging
    as_of = params.get("as_of") or _today()
    return await compute_ap_aging(cid, as_of=as_of)


async def _fetch_inventory_valuation(cid: str, params: dict) -> dict:
    import inventory_service
    return await inventory_service.compute_valuation(cid)


async def _fetch_reorder_alerts(cid: str, params: dict) -> dict:
    import inventory_service
    return await inventory_service.compute_reorder_alerts(cid)


CHART_REGISTRY: dict[str, dict] = {
    "income_statement": {
        "title": "Income Statement",
        "description": "Revenue, expenses, and net income over a date range. Great for 'how much did I make', 'why is profit down', 'what are my biggest expenses'.",
        "params_hint": "start (YYYY-MM-DD), end (YYYY-MM-DD), basis ('accrual'|'cash')",
        "fetcher": _fetch_income_statement,
    },
    "balance_sheet": {
        "title": "Balance Sheet",
        "description": "Assets, liabilities, and equity as of a date. Great for 'what's my net worth', 'do I have inventory on the books', 'how much do I owe'.",
        "params_hint": "as_of (YYYY-MM-DD), basis ('accrual'|'cash')",
        "fetcher": _fetch_balance_sheet,
    },
    "ar_aging": {
        "title": "A/R Aging (who owes me)",
        "description": "Outstanding customer invoices bucketed by days overdue. Great for 'who owes me the most', 'what's past due'.",
        "params_hint": "as_of (YYYY-MM-DD)",
        "fetcher": _fetch_ar_aging,
    },
    "ap_aging": {
        "title": "A/P Aging (who I owe)",
        "description": "Outstanding vendor bills bucketed by days overdue. Great for 'what bills are due', 'who am I behind on'.",
        "params_hint": "as_of (YYYY-MM-DD)",
        "fetcher": _fetch_ap_aging,
    },
    "inventory_valuation": {
        "title": "Inventory Valuation",
        "description": "Every tracked item with quantity on hand, weighted-average cost, and total value. Great for 'how much inventory do I have', 'what's my most valuable stock'.",
        "params_hint": "(no params)",
        "fetcher": _fetch_inventory_valuation,
    },
    "reorder_alerts": {
        "title": "Reorder Alerts (low stock)",
        "description": "Inventory items at or below their low-stock threshold. Great for 'what do I need to buy', 'am I running low on anything'.",
        "params_hint": "(no params)",
        "fetcher": _fetch_reorder_alerts,
    },
}


# ── Helpers ──────────────────────────────────────────────────────────

def _today() -> str:
    return date.today().isoformat()


def _default_period_start() -> str:
    return (date.today() - timedelta(days=90)).isoformat()


def _chart_menu_prompt() -> str:
    lines = []
    for cid_, meta in CHART_REGISTRY.items():
        lines.append(f'  • "{cid_}" → {meta["title"]}. {meta["description"]} Params: {meta["params_hint"]}.')
    return "\n".join(lines)


_SYSTEM = (
    "You are the SmartBooks Insights Assistant — a friendly, precise "
    "financial-reporting companion embedded in a small floating widget "
    "at the bottom of a bookkeeping app. Your job is to answer the user's "
    "question about their business finances by (a) picking the most "
    "relevant chart from the registry below, (b) choosing sensible "
    "params, and (c) writing a SHORT, warm, plain-English explanation "
    "of what that chart will show them. The app itself fetches the real "
    "numbers — you never invent them.\n\n"
    "CHART REGISTRY:\n" + "{registry}" + "\n\n"
    "OUTPUT FORMAT — respond with STRICT JSON (no code fences, no extra prose) matching exactly:\n"
    "{\n"
    '  "answer": "<2-4 sentence conversational explanation of what you\'re showing them and why. Never quote specific $ figures — just describe.>",\n'
    '  "chart_id": "<one of the registry keys, or null if the question is generic conversation>",\n'
    '  "chart_params": {},\n'
    '  "quick_actions": [\n'
    '    {"label": "<short verb phrase>", "kind": "navigate", "to": "/some-route"}\n'
    "  ]\n"
    "}\n\n"
    "RULES:\n"
    "• If the user's question does not map to any chart (small talk, "
    "  'thanks', 'who are you'), set chart_id=null and just answer.\n"
    "• Dates: when the user says 'this month' resolve to the current "
    "  month, 'last quarter' → previous 3 whole months, 'YTD' → Jan 1 to today.\n"
    "• Never fabricate numbers. Always let the chart show them.\n"
    "• `quick_actions` are optional — 0-3 items, links like '/reports/income-statement', '/transactions', '/inventory-management'.\n"
    "• Today is " + _today() + "."
)


def _system_prompt() -> str:
    return _SYSTEM.replace("{registry}", _chart_menu_prompt())


def _extract_json(text: str) -> Optional[dict]:
    if not text:
        return None
    # Strip common markdown fences the LLM sometimes wraps JSON in.
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    # Try to parse the whole payload first (fast path), then fall back
    # to grabbing the widest {...} substring.
    try:
        return json.loads(t)
    except Exception:  # noqa: BLE001
        pass
    m = re.search(r"\{[\s\S]*\}", t)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:  # noqa: BLE001
        return None


# ── API ──────────────────────────────────────────────────────────────

class InsightsAskIn(BaseModel):
    question: str
    session_id: Optional[str] = None      # keeps conversation memory
    page: Optional[str] = None            # current app route for context
    chart_hint: Optional[str] = None      # optional chart the user is looking at
    page_charts: Optional[list[str]] = None  # chart_ids the current page has
                                             # registered via useRegisterChart
    monthly_cap_usd: Optional[float] = None  # soft cap for cost tracking


# ── Cost caps (per-company monthly ceiling) ─────────────────────────
#
# Each insights_ask call bumps a monthly counter on the company doc; the
# LLM is metered at $0.008 / request (rough Claude Sonnet 5 avg for a
# short JSON reply — override via COST_PER_INSIGHTS_CALL env var).
# `cap_status()` returns one of: "ok" | "warn" (>=80%) | "block".
import os as _os
_COST_PER_CALL = float(_os.environ.get("COST_PER_INSIGHTS_CALL") or 0.008)


def _current_period() -> str:
    from datetime import date as _d
    return _d.today().strftime("%Y-%m")


async def _cap_status(cid: str, monthly_cap: Optional[float]) -> tuple[str, dict]:
    """Return (status, meta) where status ∈ ok|warn|block. Meta carries
    the spend + cap for surfacing to the client."""
    period = _current_period()
    doc = await db.companies.find_one({"id": cid}, {"insights_spend": 1}) or {}
    spend_map = doc.get("insights_spend") or {}
    spent = float(spend_map.get(period) or 0)
    cap = float(monthly_cap or 0)  # 0 → unlimited
    status = "ok"
    if cap > 0:
        if spent >= cap:
            status = "block"
        elif spent >= 0.8 * cap:
            status = "warn"
    return status, {"period": period, "spent": round(spent, 4),
                    "cap": cap, "per_call": _COST_PER_CALL}


async def _bump_spend(cid: str) -> None:
    await db.companies.update_one(
        {"id": cid},
        {"$inc": {f"insights_spend.{_current_period()}": _COST_PER_CALL},
         "$set": {"updated_at": now_iso()}},
    )


class QuickAction(BaseModel):
    label: str
    kind: str = "navigate"
    to: Optional[str] = None


class InsightsAskOut(BaseModel):
    session_id: str
    answer: str
    chart_id: Optional[str] = None
    chart_title: Optional[str] = None
    chart_data: Optional[dict] = None
    quick_actions: list[QuickAction] = []


@router.post("/companies/{cid}/ai/insights/ask", response_model=InsightsAskOut)
async def insights_ask(cid: str, inp: InsightsAskIn,
                       user: dict = Depends(get_current_user)):
    """Chart-aware conversational Q&A for reports & dashboard tiles.

    Flow:
      1. LLM picks a `chart_id` from the registry and params (never a
         raw $ figure).
      2. This endpoint runs the corresponding fetcher against the
         user's real data.
      3. Response bundles the LLM's plain-English answer with the
         actual chart_data so the widget can render it live.
    """
    await require_company(user, cid)
    q = (inp.question or "").strip()
    if not q:
        raise HTTPException(400, "question is required")

    # Cost gate — refuse when the caller has burned through their monthly
    # ceiling. `warn` still lets the request through but the frontend
    # can show a soft banner.
    status, meta = await _cap_status(cid, inp.monthly_cap_usd)
    if status == "block":
        raise HTTPException(
            status_code=402,
            detail={"error": "insights_cap_reached", **meta,
                    "message": "Monthly Insights budget reached. Raise the cap in Settings or wait for next month."},
        )

    session_id = inp.session_id or str(uuid.uuid4())
    # Add a tiny bit of context so the LLM can resolve "this chart" /
    # "this page" style questions without a full context registry.
    ctx_lines = []
    if inp.page:      ctx_lines.append(f"Current page: {inp.page}")
    if inp.chart_hint:
        meta = CHART_REGISTRY.get(inp.chart_hint)
        if meta:
            ctx_lines.append(f"User is currently looking at: {meta['title']} ({inp.chart_hint}).")
    user_msg = q if not ctx_lines else "\n".join(ctx_lines) + "\n\nQuestion: " + q

    chat = LlmChat(
        api_key="",  # llm_client resolves from env
        session_id="insights-" + session_id,
        system_message=_system_prompt(),
        feature="insights-chat",
    ).with_model(MODEL_PROVIDER, MODEL_NAME)
    try:
        raw = await chat.send_message(UserMessage(text=user_msg))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error: {e}")

    # `send_message` may return either a string or an object with `.text`
    # depending on backend model — normalize.
    raw_text = raw if isinstance(raw, str) else (getattr(raw, "text", "") or str(raw))
    parsed = _extract_json(raw_text) or {}
    if not parsed:
        print(f"[insights_chat] LLM unparseable payload → {raw_text!r}"[:1000], flush=True)
    answer = (parsed.get("answer") or "").strip() \
             or "I wasn't sure how to answer that — try rephrasing?"
    chart_id = parsed.get("chart_id")
    chart_params = parsed.get("chart_params") or {}
    quick_actions_raw = parsed.get("quick_actions") or []

    # Fetch the real chart data server-side — LLM never touches raw numbers.
    chart_data = None
    chart_title = None
    if chart_id and chart_id in CHART_REGISTRY:
        meta = CHART_REGISTRY[chart_id]
        chart_title = meta["title"]
        try:
            chart_data = await meta["fetcher"](cid, chart_params if isinstance(chart_params, dict) else {})
        except Exception as e:  # noqa: BLE001
            # Data-fetch failure shouldn't kill the whole response — surface
            # a graceful degraded state.
            answer += f"\n\n(I couldn't load the chart right now: {e})"
            chart_id = None
            chart_title = None

    # Normalize quick_actions defensively.
    quick_actions: list[QuickAction] = []
    for qa in (quick_actions_raw if isinstance(quick_actions_raw, list) else [])[:3]:
        if isinstance(qa, dict) and qa.get("label"):
            quick_actions.append(QuickAction(
                label=str(qa["label"])[:60],
                kind=str(qa.get("kind") or "navigate"),
                to=str(qa["to"]) if qa.get("to") else None,
            ))

    # Persist a lightweight transcript for the widget's history view.
    try:
        await db.insights_chat_log.insert_one({
            "id": str(uuid.uuid4()),
            "company_id": cid,
            "user_id": user["id"],
            "session_id": session_id,
            "question": q,
            "answer": answer,
            "chart_id": chart_id,
            "created_at": now_iso(),
        })
        await _bump_spend(cid)
    except Exception:  # noqa: BLE001
        pass

    return InsightsAskOut(
        session_id=session_id,
        answer=answer,
        chart_id=chart_id,
        chart_title=chart_title,
        chart_data=chart_data,
        quick_actions=quick_actions,
    )


@router.get("/companies/{cid}/ai/insights/history")
async def insights_history(cid: str, session_id: Optional[str] = None,
                           limit: int = 20,
                           user: dict = Depends(get_current_user)):
    """Recent Q&A rows for the widget's collapsible history view."""
    await require_company(user, cid)
    q: dict[str, Any] = {"company_id": cid, "user_id": user["id"]}
    if session_id:
        q["session_id"] = session_id
    rows = await db.insights_chat_log.find(q).sort("created_at", -1).limit(limit).to_list(limit)
    for r in rows:
        r.pop("_id", None)
    return {"rows": rows}


@router.get("/companies/{cid}/ai/insights/registry")
async def insights_registry(cid: str, user: dict = Depends(get_current_user)):
    """Expose the chart registry so the frontend can render "starter
    prompts" (Balance Sheet · Income Statement · A/R Aging · …) without
    hard-coding the list twice."""
    await require_company(user, cid)
    return {
        "charts": [
            {"id": cid_, "title": meta["title"], "description": meta["description"]}
            for cid_, meta in CHART_REGISTRY.items()
        ]
    }


@router.get("/companies/{cid}/ai/insights/budget")
async def insights_budget(cid: str, monthly_cap: Optional[float] = None,
                          user: dict = Depends(get_current_user)):
    """Return current-month insights spend + cap. Used by the widget to
    render the 80%-warn banner."""
    await require_company(user, cid)
    status, meta = await _cap_status(cid, monthly_cap)
    return {"status": status, **meta}


# ── SSE streaming variant ────────────────────────────────────────────
#
# The non-streaming `ask` above returns the whole JSON after the LLM
# finishes. This variant emits the same shape but progressively:
#   `event: text_delta`  → partial `answer` text chunks (from the LLM
#                          stream while it types out its `answer` field)
#   `event: chart`       → single event carrying the resolved chart_id,
#                          chart_title, chart_data + quick_actions once
#                          the JSON has been fully parsed
#   `event: done`        → terminal marker
#
# Streaming a JSON payload directly is fragile, so we take a two-phase
# approach: let the model write to completion, extract the JSON,
# then simulate word-by-word streaming of the answer field so the UX
# feels alive while chart_data lands atomically at the end. Cost is
# identical to the non-streaming call.


@router.post("/companies/{cid}/ai/insights/ask/stream")
async def insights_ask_stream(cid: str, inp: InsightsAskIn,
                              user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    q = (inp.question or "").strip()
    if not q:
        raise HTTPException(400, "question is required")

    status, meta = await _cap_status(cid, inp.monthly_cap_usd)
    if status == "block":
        raise HTTPException(status_code=402, detail={"error": "insights_cap_reached", **meta})

    session_id = inp.session_id or str(uuid.uuid4())
    ctx_lines = []
    if inp.page:
        ctx_lines.append(f"Current page: {inp.page}")
    if inp.chart_hint:
        meta_c = CHART_REGISTRY.get(inp.chart_hint)
        if meta_c:
            ctx_lines.append(f"User is currently looking at: {meta_c['title']} ({inp.chart_hint}).")
    if inp.page_charts:
        # Charts the frontend registered on this page via
        # `useRegisterChart`. We only echo the ids so the LLM can
        # PREFER them, but any chart in the registry stays valid.
        valid = [c for c in inp.page_charts if c in CHART_REGISTRY]
        if valid:
            ctx_lines.append("Charts already visible on this page: " + ", ".join(valid))
    user_msg = q if not ctx_lines else "\n".join(ctx_lines) + "\n\nQuestion: " + q

    chat = LlmChat(
        api_key="",
        session_id="insights-" + session_id,
        system_message=_system_prompt(),
        feature="insights-chat",
    ).with_model(MODEL_PROVIDER, MODEL_NAME)

    async def event_gen():
        import asyncio
        try:
            raw = await chat.send_message(UserMessage(text=user_msg))
        except Exception as e:  # noqa: BLE001
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
            return
        raw_text = raw if isinstance(raw, str) else (getattr(raw, "text", "") or str(raw))
        parsed = _extract_json(raw_text) or {}
        answer = (parsed.get("answer") or "").strip() \
                 or "I wasn't sure how to answer that — try rephrasing?"
        chart_id = parsed.get("chart_id") or None
        chart_params = parsed.get("chart_params") or {}
        quick_actions_raw = parsed.get("quick_actions") or []

        # Stream the answer text word-by-word for the "typing" feel.
        words = answer.split(" ")
        for i, w in enumerate(words):
            chunk = w + (" " if i < len(words) - 1 else "")
            yield f"event: text_delta\ndata: {json.dumps({'content': chunk})}\n\n"
            await asyncio.sleep(0.018)   # ~55 words/sec cadence

        # Now fetch chart data + emit the chart event.
        chart_data, chart_title = None, None
        if chart_id and chart_id in CHART_REGISTRY:
            m = CHART_REGISTRY[chart_id]
            chart_title = m["title"]
            try:
                chart_data = await m["fetcher"](
                    cid, chart_params if isinstance(chart_params, dict) else {}
                )
            except Exception as e:  # noqa: BLE001
                yield f"event: text_delta\ndata: {json.dumps({'content': f' (chart failed to load: {e})'})}\n\n"
                chart_id = None
        quick_actions: list[dict] = []
        for qa in (quick_actions_raw if isinstance(quick_actions_raw, list) else [])[:3]:
            if isinstance(qa, dict) and qa.get("label"):
                quick_actions.append({
                    "label": str(qa["label"])[:60],
                    "kind": str(qa.get("kind") or "navigate"),
                    "to": str(qa["to"]) if qa.get("to") else None,
                })
        yield "event: chart\ndata: " + json.dumps({
            "chart_id": chart_id,
            "chart_title": chart_title,
            "chart_data": chart_data,
            "quick_actions": quick_actions,
        }) + "\n\n"

        # Persist + meter spend.
        try:
            await db.insights_chat_log.insert_one({
                "id": str(uuid.uuid4()),
                "company_id": cid,
                "user_id": user["id"],
                "session_id": session_id,
                "question": q,
                "answer": answer,
                "chart_id": chart_id,
                "created_at": now_iso(),
            })
            await _bump_spend(cid)
        except Exception:  # noqa: BLE001
            pass

        yield f"event: done\ndata: {json.dumps({'session_id': session_id, 'cap_status': status})}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
