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
from pydantic import BaseModel

from auth import get_current_user
from deps import require_company
from db import db, now_iso
from llm_client import LlmChat, UserMessage
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
