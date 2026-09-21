"""Cockpit — Today v4 aggregate endpoint.

Manager-view dashboard: what the AI junior is doing so the CPA doesn't
have to. Composes signal from ingestion writes, learned rules, W-9
outreach, month-closes, client-review batches, and reconciliation.
Any metric we can't source cleanly today is served with `mocked: True`
so the frontend can render a subtle chip — no fake numbers.

One endpoint → one round trip → one dashboard.
"""
from __future__ import annotations
from calendar import monthrange
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from db import db
from auth import get_current_user
from routes.cockpit import require_firm_or_pro


router = APIRouter(prefix="/api/cockpit")


# Time-saved heuristic (seconds per AI-handled event) — see design doc.
SEC_PER_AUTO_POST = 30
SEC_PER_TRANSFER_MATCH = 60
SEC_PER_ALIAS = 45
SEC_PER_RULE = 300
SEC_PER_W9 = 900


def _since_iso(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _since_date(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()


def _iso_ago(iso) -> str:
    if not iso:
        return ""
    try:
        d = iso if isinstance(iso, datetime) else datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return ""
    now = datetime.now(timezone.utc)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    if d.date() == now.date():
        return d.strftime("%-I:%M %p")
    diff = (now.date() - d.date()).days
    if diff == 1:
        return "Yesterday"
    if 0 < diff < 7:
        return f"{diff}d ago"
    return d.strftime("%b %-d")


def _hour_str(iso) -> str:
    if not iso:
        return ""
    try:
        d = iso if isinstance(iso, datetime) else datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return d.strftime("%-I:%M %p")
    except Exception:  # noqa: BLE001
        return ""


@router.get("/today-v4")
async def today_v4(
    days: int = Query(7, ge=1, le=90),
    user: dict = Depends(get_current_user),
):
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"empty": True, "days": days}

    since_dt_iso = _since_iso(days)
    since_date = _since_date(days)

    companies = await db.companies.find({"id": {"$in": accessible}}).to_list(2000)
    name_by_id = {c["id"]: c.get("name") or "Untitled" for c in companies}
    now = datetime.now(timezone.utc)

    # ---- 1. AI ACTIVITY PULSE -------------------------------------
    txns_total = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "date": {"$gte": since_date},
    })
    txns_prev = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "date": {"$gte": _since_date(days * 2), "$lt": since_date},
    })
    # auto-posted rows carry ai_source ∈ {rule, contact_directory, plaid_pfc, llm}
    # and needs_review=False; anything else is either pro-touched or in queue.
    auto_posted = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "date": {"$gte": since_date},
        "needs_review": False,
        "ai_source": {"$exists": True, "$nin": [None, ""]},
    })
    queued = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "date": {"$gte": since_date},
        "needs_review": True,
    })
    rules_learned = await db.rules.count_documents({
        "company_id": {"$in": accessible},
        "created_at": {"$gte": since_dt_iso},
    })
    w9_captured = await db.agent_findings.count_documents({
        "company_id": {"$in": accessible},
        "kind": "w9_auto_captured",
        "created_at": {"$gte": since_dt_iso},
    })
    aliases_learned = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "posted_at": {"$gte": since_dt_iso},
        "contact_resolution": "alias",
    })
    # Bank-match count — auto_match_bank_feed writes a hint on the txn
    transfer_matches = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "date": {"$gte": since_date},
        "transfer_matched_at": {"$exists": True},
    })

    # Sparkline: last N days daily txn counts
    daily_counts = []
    for i in range(days - 1, -1, -1):
        d = (now - timedelta(days=i)).date().isoformat()
        c = await db.transactions.count_documents({
            "company_id": {"$in": accessible}, "date": d,
        })
        daily_counts.append({"date": d, "count": c})

    # Velocity: rolling auto-posted % per day for last 30d
    velocity_series = []
    for i in range(29, -1, -1):
        d = (now - timedelta(days=i)).date().isoformat()
        total = await db.transactions.count_documents({
            "company_id": {"$in": accessible}, "date": d,
        })
        auto = await db.transactions.count_documents({
            "company_id": {"$in": accessible}, "date": d,
            "needs_review": False,
            "ai_source": {"$exists": True, "$nin": [None, ""]},
        })
        pct = round(auto / total * 100, 1) if total else 0
        velocity_series.append({"date": d, "pct": pct})

    seconds_saved = (
        auto_posted * SEC_PER_AUTO_POST +
        transfer_matches * SEC_PER_TRANSFER_MATCH +
        aliases_learned * SEC_PER_ALIAS +
        rules_learned * SEC_PER_RULE +
        w9_captured * SEC_PER_W9
    )
    hours_saved = round(seconds_saved / 3600.0, 1)
    tasks_handled = auto_posted + transfer_matches + aliases_learned + rules_learned + w9_captured

    time_saved_donut = [
        {"key": "categorization", "label": "Categorization",
         "hours": round(auto_posted * SEC_PER_AUTO_POST / 3600, 1)},
        {"key": "reconciliation", "label": "Reconciliation & transfers",
         "hours": round(transfer_matches * SEC_PER_TRANSFER_MATCH / 3600, 1)},
        {"key": "learning", "label": "Contact / alias learning",
         "hours": round(aliases_learned * SEC_PER_ALIAS / 3600, 1)},
        {"key": "rules", "label": "Rules mined",
         "hours": round(rules_learned * SEC_PER_RULE / 3600, 1)},
        {"key": "w9", "label": "W-9 capture",
         "hours": round(w9_captured * SEC_PER_W9 / 3600, 1)},
    ]

    pct_change = 0
    if txns_prev > 0:
        pct_change = round((txns_total - txns_prev) / txns_prev * 100, 1)

    activity = {
        "txns_processed": {
            "value": txns_total,
            "sparkline": daily_counts,
            "delta_pct": pct_change,
        },
        "auto_posted": {
            "count": auto_posted,
            "pct": round(auto_posted / txns_total * 100, 1) if txns_total else 0,
            "queued_count": queued,
        },
        "rules_learned": rules_learned,
        "w9_captured": w9_captured,
        "time_saved_donut": time_saved_donut,
        "velocity_series": velocity_series,
    }

    # ---- 2. CLIENT CONVERSATIONS ----------------------------------
    today_iso = now.date().isoformat()
    end_of_day = (now.replace(hour=23, minute=59, second=59)).isoformat()

    scheduled_today = []
    async for b in db.client_review_batches.find({
        "company_id": {"$in": accessible},
        "status": "scheduled",
        "scheduled_at": {"$gte": now.isoformat(), "$lte": end_of_day},
    }).sort("scheduled_at", 1).limit(10):
        items = b.get("items") or []
        scheduled_today.append({
            "id": b.get("id"),
            "company": name_by_id.get(b.get("company_id"), ""),
            "at": _hour_str(b.get("scheduled_at")),
            "count": len(items),
            "types": _item_type_mix(items),
            "route": f"/cockpit/requests?batch={b.get('id')}",
        })

    in_progress = []
    async for b in db.client_review_batches.find({
        "company_id": {"$in": accessible},
        "status": "in_progress",
    }).sort("updated_at", -1).limit(8):
        items = b.get("items") or []
        answered = sum(1 for it in items if it.get("status") in ("answered", "deferred"))
        current = next((it for it in items if it.get("status") not in ("answered", "deferred")), None)
        in_progress.append({
            "id": b.get("id"),
            "company": name_by_id.get(b.get("company_id"), ""),
            "answered": answered,
            "total": len(items),
            "current_type": (current or {}).get("kind") or "…",
            "started_ago": _iso_ago(b.get("started_at") or b.get("sent_at")),
            "route": f"/cockpit/requests?batch={b.get('id')}",
        })

    waiting = []
    async for b in db.client_review_batches.find({
        "company_id": {"$in": accessible},
        "status": {"$in": ["sent", "reminded", "passive_miss"]},
    }).sort("sent_at", 1).limit(10):
        sent_at = b.get("sent_at")
        try:
            sent_dt = datetime.fromisoformat(str(sent_at).replace("Z", "+00:00"))
            if sent_dt.tzinfo is None:
                sent_dt = sent_dt.replace(tzinfo=timezone.utc)
            days_silent = (now - sent_dt).days
        except Exception:  # noqa: BLE001
            days_silent = 0
        waiting.append({
            "id": b.get("id"),
            "company": name_by_id.get(b.get("company_id"), ""),
            "count": len(b.get("items") or []),
            "days_silent": days_silent,
            "reminder_at": _hour_str(b.get("reminder_at")),
            "route": f"/cockpit/requests?batch={b.get('id')}",
        })

    conversations = {
        "scheduled_today": scheduled_today,
        "in_progress": in_progress,
        "waiting_on_client": waiting,
        "empty": len(scheduled_today) == 0 and len(in_progress) == 0 and len(waiting) == 0,
    }

    # ---- 3. BOOKS PULSE -------------------------------------------
    client_health = []
    for c in companies:
        cid = c["id"]
        total = await db.transactions.count_documents({"company_id": cid})
        unrev = await db.transactions.count_documents({
            "company_id": cid, "needs_review": True,
        })
        recon_pct = 100 if total == 0 else round(max(0, 1 - unrev / total) * 100)
        # Cash sparkline: 7-day balance running total
        cash_spark = []
        running = 0.0
        for i in range(6, -1, -1):
            d = (now - timedelta(days=i)).date().isoformat()
            day_sum_rows = await db.transactions.aggregate([
                {"$match": {"company_id": cid, "date": d}},
                {"$group": {"_id": None, "s": {"$sum": "$amount"}}}
            ]).to_list(1)
            running += (day_sum_rows[0]["s"] if day_sum_rows else 0)
            cash_spark.append(round(running))
        # Last close status — most recent "closed" signoff for this company.
        last_close = await db.month_close_signoffs.find_one(
            {"company_id": cid, "kind": "closed"},
            sort=[("year", -1), ("month", -1)],
        )
        close_state = "Not started"
        if last_close:
            try:
                ly = int(last_close.get("year"))
                lm = int(last_close.get("month"))
                close_state = f"{datetime(ly, lm, 1).strftime('%b %Y')} ✓"
            except Exception:  # noqa: BLE001
                close_state = "—"
        client_health.append({
            "id": cid,
            "name": c.get("name") or "Untitled",
            "recon_pct": recon_pct,
            "cash_spark": cash_spark,
            "cash_current": cash_spark[-1] if cash_spark else 0,
            "close_state": close_state,
            "open_items": unrev,
        })
    # Least healthy first
    client_health.sort(key=lambda x: x["recon_pct"])

    # Cross-client daily volume: last 14d, top 5 clients
    top_ids = [c["id"] for c in client_health[:5]] or [c["id"] for c in companies[:5]]
    cross_volume = []
    for i in range(13, -1, -1):
        d = (now - timedelta(days=i)).date().isoformat()
        row = {"date": d}
        for cid in top_ids:
            row[cid] = await db.transactions.count_documents({
                "company_id": cid, "date": d,
            })
        cross_volume.append(row)
    top_labels = [{"id": cid, "name": name_by_id.get(cid, "?")} for cid in top_ids]

    # Runway top 4 (mocked flag on — heuristic only)
    runway = []
    for c in client_health[:4]:
        cid = c["id"]
        outflows = await db.transactions.aggregate([
            {"$match": {"company_id": cid, "amount": {"$lt": 0},
                        "date": {"$gte": _since_date(90)}}},
            {"$group": {"_id": None, "s": {"$sum": "$amount"}}}
        ]).to_list(1)
        avg_monthly_burn = abs(outflows[0]["s"] / 3.0) if outflows else 0
        months = round(c["cash_current"] / avg_monthly_burn, 1) if avg_monthly_burn > 0 else None
        runway.append({
            "id": cid,
            "name": c["name"],
            "cash": c["cash_current"],
            "burn": round(avg_monthly_burn),
            "months": months,
        })

    books = {
        "clients": client_health,
        "cross_volume": cross_volume,
        "cross_labels": top_labels,
        "runway": runway,
        "runway_mocked": True,
    }

    # ---- 4. JUDGMENT NEEDED ---------------------------------------
    # Load every "closed" signoff so we can identify prior months that
    # remain unsigned. `db.month_close_signoffs` (kind='closed') is the
    # authoritative "this month has been signed off" marker.
    closed_by_company: dict[str, set] = {}
    async for so in db.month_close_signoffs.find({
        "company_id": {"$in": accessible},
        "kind": "closed",
    }):
        try:
            ym = f"{int(so['year']):04d}-{int(so['month']):02d}"
        except Exception:  # noqa: BLE001
            continue
        closed_by_company.setdefault(so.get("company_id"), set()).add(ym)

    # 🚨 Prior-month unclosed — every month older than current that has
    # transactions AND no "closed" signoff yet. Lookback capped at 12mo
    # so ancient historical periods don't clutter the panel.
    LOOKBACK_MONTHS = 12
    prior_unclosed = []
    for c in companies:
        cid = c["id"]
        closed_set = closed_by_company.get(cid, set())
        y, m = now.year, now.month
        for _ in range(LOOKBACK_MONTHS):
            m -= 1
            if m == 0:
                m = 12
                y -= 1
            ym = f"{y:04d}-{m:02d}"
            if ym in closed_set:
                continue
            start = f"{ym}-01"
            end = f"{ym}-{monthrange(y, m)[1]:02d}"
            n = await db.transactions.count_documents({
                "company_id": cid, "date": {"$gte": start, "$lte": end},
            })
            if n == 0:
                continue
            months_overdue = (now.year - y) * 12 + (now.month - m)
            prior_unclosed.append({
                "id": f"unclosed-{cid}-{ym}",
                "company_id": cid,
                "period": ym,
                "period_label": datetime(y, m, 1).strftime("%b %Y"),
                "text": f"{name_by_id.get(cid, 'Client')} · "
                        f"{datetime(y, m, 1).strftime('%B %Y')} books not closed",
                "reason": "prior_month_unclosed",
                "months_overdue": months_overdue,
                "txn_count": n,
                "route": f"/accounting/month-close?ym={ym}&company={cid}",
                "signoff_route": f"/api/companies/{cid}/month-close/{ym}/checkpoint",
            })
    # Oldest first — most overdue on top.
    prior_unclosed.sort(key=lambda x: x["period"])

    # 🚨 Blocking — vendor escalations
    blocking = []
    async for f in db.agent_findings.find({
        "company_id": {"$in": accessible},
        "kind": "vendor_outreach_escalated",
        "status": {"$ne": "resolved"},
    }).limit(5):
        blocking.append({
            "id": f.get("id"),
            "text": f"{name_by_id.get(f.get('company_id'), 'Client')} · "
                    f"vendor outreach escalated · {f.get('title') or 'W-9 chase stuck'}",
            "route": f"/company/{f.get('company_id')}/contacts",
        })

    # 👀 Judgment needed — force-flagged categorizer reasons + unusual findings
    judgment_needed = []
    async for t in db.transactions.find({
        "company_id": {"$in": accessible},
        "needs_review": True,
        "review_reason": {"$in": [
            "meals_over_cap", "bank_cash_self_cancel", "generic_pfc",
            "self_cancelling_je", "unusual_amount"]},
    }).sort("date", -1).limit(8):
        judgment_needed.append({
            "id": t.get("id"),
            "text": f"{name_by_id.get(t.get('company_id'), 'Client')} · "
                    f"{(t.get('description') or 'txn')[:56]} · ${abs(float(t.get('amount') or 0)):,.0f}",
            "reason": (t.get("review_reason") or "").replace("_", " "),
            "route": f"/company/{t.get('company_id')}/transactions?tid={t.get('id')}",
        })
    async for f in db.agent_findings.find({
        "company_id": {"$in": accessible},
        "kind": {"$in": ["unusual_amount", "self_cancelling_je", "client_deferred"]},
        "status": {"$ne": "resolved"},
    }).sort("created_at", -1).limit(5):
        judgment_needed.append({
            "id": f.get("id"),
            "text": f"{name_by_id.get(f.get('company_id'), 'Client')} · {f.get('title') or f.get('kind')}",
            "reason": (f.get("kind") or "").replace("_", " "),
            "route": f"/company/{f.get('company_id')}/dashboard",
        })

    # 📋 Optional sign-off — mined rules, near-ready closes, aging outreach
    optional = []
    unreviewed_rules = await db.rules.count_documents({
        "company_id": {"$in": accessible},
        "source": "miner",
        "created_at": {"$gte": since_dt_iso},
        "reviewed_by_pro": {"$in": [None, False]},
    })
    if unreviewed_rules > 0:
        optional.append({
            "id": "mined-rules",
            "text": f"{unreviewed_rules} new auto-promoted rules this week — "
                    f"quick review before they compound",
            "route": "/settings/rules",
        })
    near_ready_closes = 0
    for c in client_health:
        if c["recon_pct"] >= 95 and c["open_items"] > 0:
            near_ready_closes += 1
    if near_ready_closes > 0:
        optional.append({
            "id": "near-ready-closes",
            "text": f"{near_ready_closes} client{'' if near_ready_closes == 1 else 's'} "
                    f"have reconciliation ≥95% — nudge them or sign off",
            "route": "/cockpit/close",
        })
    aging_outreach = await db.vendor_outreaches.count_documents({
        "company_id": {"$in": accessible},
        "status": {"$in": ["waiting_reply", "reminded"]},
        "last_touch_at": {"$lt": _since_iso(14)},
    })
    if aging_outreach > 0:
        optional.append({
            "id": "aging-outreach",
            "text": f"{aging_outreach} vendor-outreach thread"
                    f"{'' if aging_outreach == 1 else 's'} waiting >14 days — escalate or drop",
            "route": "/cockpit/communications",
        })

    # 🤝 Client relationship — ghosted batches
    ghosted = {}
    async for b in db.client_review_batches.find({
        "company_id": {"$in": accessible},
        "status": "expired",
        "expired_at": {"$gte": _since_iso(14)},
    }):
        cid = b.get("company_id")
        ghosted[cid] = ghosted.get(cid, 0) + 1
    relationship = []
    for cid, cnt in ghosted.items():
        if cnt >= 2:
            relationship.append({
                "id": f"ghost-{cid}",
                "text": f"{name_by_id.get(cid, 'Client')} has ghosted "
                        f"{cnt} check-ins in a row — a warm ping may help",
                "route": f"/company/{cid}/dashboard",
            })

    judgment = {
        "prior_unclosed": prior_unclosed,
        "blocking": blocking,
        "needed": judgment_needed,
        "optional": optional,
        "relationship": relationship,
    }

    return {
        "days": days,
        "header": {
            "hours_saved": hours_saved,
            "tasks_handled": tasks_handled,
            "tasks_escalated": len(prior_unclosed) + len(blocking) + len(judgment_needed),
        },
        "activity": activity,
        "conversations": conversations,
        "books": books,
        "judgment": judgment,
    }


def _item_type_mix(items) -> list:
    """Compact type-tally for a batch — {'uncategorized': 3, 'w9': 1}."""
    tally = {}
    for it in items or []:
        k = (it.get("kind") or "other").split("_")[0]
        tally[k] = tally.get(k, 0) + 1
    return [{"kind": k, "count": v} for k, v in tally.items()]
