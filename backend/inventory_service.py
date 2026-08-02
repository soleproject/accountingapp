"""Axiom Ledger — Inventory service (Tier 2, Weighted Average).

Central engine for all inventory bookkeeping side-effects triggered by
bills, invoices, and manual adjustments. Keeps items, journal entries,
and the inventory-movements audit trail in sync.

Design (agreed with user Feb 2026):
  • Weighted-average costing (no FIFO/LIFO).
  • Starts from *today* — historical bills/invoices are NOT backfilled;
    we only react to saves that happen after the item was flipped to
    `track_inventory=True`.
  • Warn-but-allow negative QOH — callers surface the warning; we still
    post the JE and update the item.
  • Bill-side JE (`DR Inventory / CR line's expense_account_id`) is the
    ONLY way inventory sits on the BS between purchase and sale. The
    CR to the same expense account intentionally offsets both the
    cash-based expense (when the bill is later paid) and the accrual
    A/P adjustment in `reports._open_ar_ap` so inventory purchases
    never hit the P&L until sold.
  • Invoice-side JE (`DR COGS / CR Inventory`) is posted at the item's
    current weighted-avg cost, atomically with the invoice save.

Idempotency is achieved by stamping the JE ids + snapshotted qty/cost
onto the bill/invoice doc under `inventory_hooks`. Every re-save
reverses the previous hook set and re-applies with fresh values.
"""
from __future__ import annotations
import uuid
from typing import Optional

from db import db, now_iso, coerce


# ── Constants ────────────────────────────────────────────────────────
SOURCE_BILL = "bill_inventory"
SOURCE_INVOICE_COGS = "invoice_cogs"
SOURCE_ADJUSTMENT = "inventory_adjustment"

MOVEMENT_TYPES = {
    "purchase":   "Bill received",
    "sale":       "Invoice sold",
    "adjustment": "Manual adjustment",
    "opening":    "Opening balance",
    "reversal":   "Reversal",
}


# ── Item helpers ─────────────────────────────────────────────────────

async def get_tracked_item(cid: str, item_id: str) -> Optional[dict]:
    """Return the item if it exists AND is currently inventory-tracked.
    Callers use this to decide whether a line-item triggers inventory
    hooks — untracked items and free-text lines are silently ignored.
    """
    if not item_id:
        return None
    it = await db.items.find_one({"id": item_id, "company_id": cid})
    if not it or not it.get("track_inventory"):
        return None
    return it


async def _resolve_line_item(cid: str, li: dict) -> Optional[dict]:
    """Resolve a line-item dict to a *tracked* item doc — either by the
    explicit `item_id` (preferred) or by an exact case-insensitive
    match against `item_name` / `description`. The name fallback exists
    because ItemPicker only stamps `item_id` when the user clicks a
    dropdown option; users who type a description that matches an
    existing item name would otherwise silently skip inventory
    bookkeeping.
    """
    if li.get("item_id"):
        return await get_tracked_item(cid, li["item_id"])
    label = ((li.get("item_name") or li.get("description") or "").strip())
    if not label:
        return None
    # Case-insensitive name match, only for tracked items.
    return await db.items.find_one({
        "company_id": cid, "track_inventory": True,
        "name": {"$regex": f"^{_regex_escape(label)}$", "$options": "i"},
    })


def _regex_escape(s: str) -> str:
    return "".join("\\" + ch if ch in r".*+?^$()[]{}|\\" else ch for ch in s)


async def _record_movement(
    cid: str, item_id: str, kind: str, qty_delta: float, unit_cost: float,
    ref: dict, memo: str = "",
) -> str:
    """Append one row to `inventory_movements`. Used purely for the
    per-item Movement report — no double-entry side-effects here.
    """
    mid = str(uuid.uuid4())
    await db.inventory_movements.insert_one({
        "id": mid,
        "company_id": cid,
        "item_id": item_id,
        "kind": kind,                                  # purchase|sale|adjustment|opening|reversal
        "qty_delta": round(float(qty_delta), 4),
        "unit_cost": round(float(unit_cost or 0), 4),
        "total": round(float(qty_delta) * float(unit_cost or 0), 2),
        "ref_kind": ref.get("kind"),                    # "bill" | "invoice" | "adjustment"
        "ref_id":   ref.get("id"),
        "ref_number": ref.get("number") or "",
        "memo": memo,
        "created_at": now_iso(),
    })
    return mid


# ── Bill-side (purchase) ─────────────────────────────────────────────

async def _reverse_bill_hooks(cid: str, bill: dict) -> None:
    """Undo everything a previous save of this bill did to inventory:
    delete the JEs, roll QOH back by the recorded delta (NOT by
    restoring a snapshot — that would wipe out any adjustments that
    happened between the save and the reversal), and write a reversal
    movement for the audit trail. Cost-basis reversal is intentionally
    conservative: we only reset it to the snapshot when the current
    cost equals what this hook produced (i.e. no other purchase has
    changed the weighted-avg in the meantime)."""
    hooks = bill.get("inventory_hooks") or []
    for h in hooks:
        # Delete the JE (BS/P&L auto-corrects on next report load).
        if h.get("je_id"):
            await db.journal_entries.delete_one({"id": h["je_id"], "company_id": cid})
        if not h.get("item_id"):
            continue
        it = await db.items.find_one({"id": h["item_id"], "company_id": cid})
        if not it:
            continue
        pre = h.get("pre") or {}
        # Reverse the QOH delta this hook applied and back-compute the
        # weighted-avg cost so any intervening adjustments/purchases
        # survive intact.
        cur_qoh = float(it.get("quantity_on_hand") or 0)
        cur_cost = float(it.get("cost_basis") or 0)
        qty = float(h.get("qty", 0))
        unit_cost = float(h.get("unit_cost", 0))
        new_qoh = cur_qoh - qty
        if new_qoh > 0:
            # Math inverse of weighted-avg absorb: value_before = value_now - qty * unit_cost.
            new_val = cur_qoh * cur_cost - qty * unit_cost
            new_cost = round(new_val / new_qoh, 4)
        else:
            # Reversal empties (or negates) stock — fall back to the
            # pre-save snapshot; anything else would be arbitrary.
            new_cost = float(pre.get("cost_basis", 0))
        set_fields = {"quantity_on_hand": new_qoh, "cost_basis": new_cost,
                      "updated_at": now_iso()}
        await db.items.update_one(
            {"id": h["item_id"], "company_id": cid}, {"$set": set_fields},
        )
        await _record_movement(
            cid, h["item_id"], "reversal",
            qty_delta=-float(h.get("qty", 0)),
            unit_cost=float(h.get("unit_cost", 0)),
            ref={"kind": "bill", "id": bill.get("id"), "number": bill.get("number")},
            memo="Reversal of prior bill save",
        )


async def apply_bill_inventory(cid: str, bill: dict) -> list[dict]:
    """Apply inventory side-effects for a bill save. Returns the list of
    hook records to persist on the bill doc under `inventory_hooks`.

    Bills with `status='draft'` are treated as non-committing (accrual
    P&L already ignores them via the accrual helper), so we short-
    circuit them here too and reverse any prior hooks.
    """
    # Reverse any prior hooks first — every save re-derives from lines.
    await _reverse_bill_hooks(cid, bill)

    if (bill.get("status") or "").lower() == "draft":
        return []

    new_hooks: list[dict] = []
    for li in (bill.get("line_items") or []):
        it = await _resolve_line_item(cid, li)
        if not it:
            continue
        # Stamp item_id back onto the line so future edits keep the link.
        li["item_id"] = it["id"]
        li["item_name"] = it.get("name") or li.get("item_name") or ""
        qty = float(li.get("quantity") or 0)
        amt = float(li.get("amount") or 0)
        if qty <= 0 or amt <= 0:
            continue
        unit_cost = round(amt / qty, 4)

        pre_qoh = float(it.get("quantity_on_hand") or 0)
        pre_cost = float(it.get("cost_basis") or 0)
        # Weighted-average recompute — never lets negative QOH pull the
        # cost negative, floors at the incoming unit cost when the pre-
        # balance is non-positive.
        base_qoh = max(pre_qoh, 0.0)
        total_val = base_qoh * pre_cost + qty * unit_cost
        new_qoh = pre_qoh + qty
        new_cost = round(total_val / (base_qoh + qty), 4) if (base_qoh + qty) > 0 else unit_cost

        # Post JE: DR Inventory / CR line expense (cancels expense
        # recognition — see module docstring).
        cr_acct_id = li.get("expense_account_id") or it.get("expense_account_id")
        cr_acct_name = li.get("expense_account_name") or it.get("expense_account_name") or ""
        if not cr_acct_id:
            # No expense account = can't post a balanced JE. Skip but
            # still update QOH so QOH stays consistent with what the
            # user sees on the bill.
            await db.items.update_one(
                {"id": it["id"], "company_id": cid},
                {"$set": {"quantity_on_hand": new_qoh, "cost_basis": new_cost,
                          "updated_at": now_iso()}},
            )
            await _record_movement(
                cid, it["id"], "purchase", qty, unit_cost,
                ref={"kind": "bill", "id": bill.get("id"), "number": bill.get("number")},
                memo="No expense account on line — no JE posted",
            )
            new_hooks.append({
                "item_id": it["id"], "qty": qty, "unit_cost": unit_cost,
                "je_id": None, "pre": {"qoh": pre_qoh, "cost_basis": pre_cost},
            })
            continue

        je_id = str(uuid.uuid4())
        await db.journal_entries.insert_one({
            "id": je_id, "company_id": cid,
            "date": bill.get("issue_date") or now_iso()[:10],
            "memo": f"Inventory receipt · {it.get('name') or ''} · Bill {bill.get('number') or ''}".strip(" ·"),
            "source": SOURCE_BILL,
            "ref_kind": "bill", "ref_id": bill.get("id"),
            "lines": [
                {"account_id": it["inventory_account_id"],
                 "account_name": it.get("inventory_account_name") or "Inventory",
                 "debit": round(amt, 2), "credit": 0.0,
                 "description": f"Received {qty} × {it.get('name') or 'item'}"},
                {"account_id": cr_acct_id,
                 "account_name": cr_acct_name,
                 "debit": 0.0, "credit": round(amt, 2),
                 "description": "Offset expense recognition (inventory)"},
            ],
            "created_at": now_iso(), "updated_at": now_iso(),
        })
        await db.items.update_one(
            {"id": it["id"], "company_id": cid},
            {"$set": {
                "quantity_on_hand": new_qoh,
                "cost_basis": new_cost,
                "updated_at": now_iso(),
            }},
        )
        await _record_movement(
            cid, it["id"], "purchase", qty, unit_cost,
            ref={"kind": "bill", "id": bill.get("id"), "number": bill.get("number")},
        )
        new_hooks.append({
            "item_id": it["id"], "qty": qty, "unit_cost": unit_cost,
            "je_id": je_id,
            "pre": {"qoh": pre_qoh, "cost_basis": pre_cost},
        })
    return new_hooks


# ── Invoice-side (sale / COGS) ───────────────────────────────────────

async def _reverse_invoice_hooks(cid: str, invoice: dict) -> None:
    """Undo an invoice save's inventory side-effects. Delta-based (adds
    the sold quantity back) so intervening adjustments survive."""
    hooks = invoice.get("inventory_hooks") or []
    for h in hooks:
        if h.get("je_id"):
            await db.journal_entries.delete_one({"id": h["je_id"], "company_id": cid})
        if not h.get("item_id"):
            continue
        it = await db.items.find_one({"id": h["item_id"], "company_id": cid})
        if not it:
            continue
        cur_qoh = float(it.get("quantity_on_hand") or 0)
        # Sales decreased QOH → reversal adds it back.
        new_qoh = cur_qoh + float(h.get("qty", 0))
        await db.items.update_one(
            {"id": h["item_id"], "company_id": cid},
            {"$set": {"quantity_on_hand": new_qoh, "updated_at": now_iso()}},
        )
        await _record_movement(
            cid, h["item_id"], "reversal",
            qty_delta=float(h.get("qty", 0)),
            unit_cost=float(h.get("unit_cost", 0)),
            ref={"kind": "invoice", "id": invoice.get("id"), "number": invoice.get("number")},
            memo="Reversal of prior invoice save",
        )


async def apply_invoice_inventory(cid: str, invoice: dict) -> tuple[list[dict], list[str]]:
    """Apply inventory side-effects for an invoice save. Returns
    (hook_records, negative_stock_warnings). Draft invoices are
    treated as non-committing.
    """
    await _reverse_invoice_hooks(cid, invoice)

    warnings: list[str] = []
    if (invoice.get("status") or "").lower() == "draft":
        return [], warnings

    new_hooks: list[dict] = []
    for li in (invoice.get("line_items") or []):
        it = await _resolve_line_item(cid, li)
        if not it:
            continue
        # Stamp item_id back so subsequent edits stay linked.
        li["item_id"] = it["id"]
        li["item_name"] = it.get("name") or li.get("item_name") or ""
        qty = float(li.get("quantity") or 0)
        if qty <= 0:
            continue
        pre_qoh = float(it.get("quantity_on_hand") or 0)
        cost = float(it.get("cost_basis") or 0)
        new_qoh = pre_qoh - qty

        if new_qoh < 0:
            warnings.append(
                f"{it.get('name') or 'Item'}: selling {qty} would leave "
                f"quantity on hand at {new_qoh:.2f} (was {pre_qoh:.2f})."
            )

        cogs_amt = round(qty * cost, 2)
        je_id: Optional[str] = None
        if cogs_amt > 0 and it.get("inventory_account_id") and it.get("cogs_account_id"):
            je_id = str(uuid.uuid4())
            await db.journal_entries.insert_one({
                "id": je_id, "company_id": cid,
                "date": invoice.get("issue_date") or now_iso()[:10],
                "memo": f"COGS · {it.get('name') or ''} · Invoice {invoice.get('number') or ''}".strip(" ·"),
                "source": SOURCE_INVOICE_COGS,
                "ref_kind": "invoice", "ref_id": invoice.get("id"),
                "lines": [
                    {"account_id": it["cogs_account_id"],
                     "account_name": it.get("cogs_account_name") or "Cost of Goods Sold",
                     "debit": cogs_amt, "credit": 0.0,
                     "description": f"COGS for {qty} × {it.get('name') or 'item'}"},
                    {"account_id": it["inventory_account_id"],
                     "account_name": it.get("inventory_account_name") or "Inventory",
                     "debit": 0.0, "credit": cogs_amt,
                     "description": f"Release {qty} × {it.get('name') or 'item'} at avg cost"},
                ],
                "created_at": now_iso(), "updated_at": now_iso(),
            })

        await db.items.update_one(
            {"id": it["id"], "company_id": cid},
            {"$set": {"quantity_on_hand": new_qoh, "updated_at": now_iso()}},
        )
        await _record_movement(
            cid, it["id"], "sale", -qty, cost,
            ref={"kind": "invoice", "id": invoice.get("id"), "number": invoice.get("number")},
        )
        new_hooks.append({
            "item_id": it["id"], "qty": qty, "unit_cost": cost,
            "je_id": je_id,
            "pre": {"qoh": pre_qoh, "cost_basis": cost},
        })
    return new_hooks, warnings


# ── Manual adjustments ───────────────────────────────────────────────

_ADJ_REASONS = {"shrinkage", "damage", "recount", "opening", "other"}


async def apply_adjustment(
    cid: str, item_id: str, new_qoh: Optional[float], qty_delta: Optional[float],
    new_cost_basis: Optional[float], reason: str, memo: str = "",
) -> dict:
    """Manual inventory adjustment. Callers pass EITHER `new_qoh` (absolute
    set) or `qty_delta` (relative). If both are given, `new_qoh` wins.

    We post a balancing JE against the item's Inventory account and the
    "Inventory adjustments" P&L account (auto-created if missing) so
    the movement flows through the double-entry system.
    """
    if reason not in _ADJ_REASONS:
        raise ValueError(f"reason must be one of {sorted(_ADJ_REASONS)}")
    it = await db.items.find_one({"id": item_id, "company_id": cid})
    if not it or not it.get("track_inventory"):
        raise ValueError("Item not found or not inventory-tracked")

    pre_qoh = float(it.get("quantity_on_hand") or 0)
    pre_cost = float(it.get("cost_basis") or 0)
    if new_qoh is not None:
        target_qoh = float(new_qoh)
        delta = target_qoh - pre_qoh
    else:
        delta = float(qty_delta or 0)
        target_qoh = pre_qoh + delta
    target_cost = float(new_cost_basis) if new_cost_basis is not None else pre_cost
    value_delta = round(delta * target_cost, 2)  # simplified: use target cost

    # Get / create the "Inventory Adjustments" expense account.
    adj_acct = await db.accounts.find_one({
        "company_id": cid,
        "type": "expense",
        "detail_type": "inventory_adjustment",
    })
    if not adj_acct:
        adj_acct = {
            "id": str(uuid.uuid4()),
            "company_id": cid,
            "type": "expense",
            "detail_type": "inventory_adjustment",
            "name": "Inventory Adjustments",
            "code": None,
            "active": True,
            "created_at": now_iso(), "updated_at": now_iso(),
        }
        await db.accounts.insert_one(adj_acct)

    je_id = None
    if abs(value_delta) >= 0.005 and it.get("inventory_account_id"):
        # +ve delta: DR Inventory / CR Adjustments (write-up, reduces expense)
        # -ve delta: CR Inventory / DR Adjustments (write-down, adds expense)
        je_id = str(uuid.uuid4())
        if value_delta > 0:
            lines = [
                {"account_id": it["inventory_account_id"], "account_name": it.get("inventory_account_name") or "Inventory",
                 "debit": abs(value_delta), "credit": 0.0, "description": memo or reason},
                {"account_id": adj_acct["id"], "account_name": adj_acct["name"],
                 "debit": 0.0, "credit": abs(value_delta), "description": memo or reason},
            ]
        else:
            lines = [
                {"account_id": adj_acct["id"], "account_name": adj_acct["name"],
                 "debit": abs(value_delta), "credit": 0.0, "description": memo or reason},
                {"account_id": it["inventory_account_id"], "account_name": it.get("inventory_account_name") or "Inventory",
                 "debit": 0.0, "credit": abs(value_delta), "description": memo or reason},
            ]
        await db.journal_entries.insert_one({
            "id": je_id, "company_id": cid,
            "date": now_iso()[:10],
            "memo": f"Inventory adjustment ({reason}) · {it.get('name') or ''}".strip(" ·"),
            "source": SOURCE_ADJUSTMENT,
            "ref_kind": "adjustment",
            "lines": lines,
            "created_at": now_iso(), "updated_at": now_iso(),
        })

    await db.items.update_one(
        {"id": item_id, "company_id": cid},
        {"$set": {
            "quantity_on_hand": target_qoh,
            "cost_basis": target_cost,
            "updated_at": now_iso(),
        }},
    )
    mid = await _record_movement(
        cid, item_id, "adjustment", delta, target_cost,
        ref={"kind": "adjustment", "id": je_id, "number": ""},
        memo=f"{reason}: {memo}" if memo else reason,
    )
    return {
        "movement_id": mid,
        "je_id": je_id,
        "item_id": item_id,
        "pre": {"qoh": pre_qoh, "cost_basis": pre_cost},
        "post": {"qoh": target_qoh, "cost_basis": target_cost},
        "delta": delta,
    }


# ── Reports helpers ──────────────────────────────────────────────────

async def compute_valuation(cid: str) -> dict:
    """Snapshot of every inventory-tracked item: qoh, avg cost, total
    value. Used by the Inventory Valuation report and dashboards.
    """
    docs = await db.items.find({"company_id": cid, "track_inventory": True}).to_list(2000)
    # Pull inventory account names in one shot so the report doesn't
    # depend on items having the cached name (older seeds may not).
    inv_ids = [it.get("inventory_account_id") for it in docs if it.get("inventory_account_id")]
    accts = {}
    if inv_ids:
        async for a in db.accounts.find({"company_id": cid, "id": {"$in": inv_ids}}):
            accts[a["id"]] = a.get("name") or ""
    rows = []
    total = 0.0
    for it in docs:
        qoh = float(it.get("quantity_on_hand") or 0)
        cost = float(it.get("cost_basis") or 0)
        value = round(qoh * cost, 2)
        total += value
        rows.append({
            "item_id": it["id"],
            "name": it.get("name") or "",
            "sku": it.get("sku") or "",
            "qoh": round(qoh, 4),
            "cost_basis": round(cost, 4),
            "value": value,
            "inventory_account_name": (it.get("inventory_account_name")
                                       or accts.get(it.get("inventory_account_id") or "", "")),
            "low_stock": (it.get("low_stock_threshold") is not None
                          and qoh <= float(it.get("low_stock_threshold") or 0)),
        })
    rows.sort(key=lambda r: r["value"], reverse=True)
    return {"rows": rows, "total_value": round(total, 2), "item_count": len(rows)}


async def list_movements(cid: str, item_id: Optional[str] = None,
                         start: Optional[str] = None, end: Optional[str] = None) -> dict:
    q = {"company_id": cid}
    if item_id:
        q["item_id"] = item_id
    if start or end:
        q["created_at"] = {}
        if start: q["created_at"]["$gte"] = start
        if end:   q["created_at"]["$lte"] = end + "T23:59:59Z"
        if not q["created_at"]:
            q.pop("created_at")
    docs = await db.inventory_movements.find(q).sort("created_at", -1).to_list(5000)
    return {"rows": [coerce(d) for d in docs], "count": len(docs)}


# ── PDF export (month-end audit binders) ─────────────────────────────

async def build_valuation_pdf(cid: str) -> bytes:
    """Print-friendly Inventory Valuation snapshot — same visual family
    as the Balance Sheet / Income Statement PDFs so it slots into an
    audit binder without formatting drift."""
    from io import BytesIO
    from datetime import date
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    from reports import _pdf_styles

    company = await db.companies.find_one({"id": cid})
    company_name = (company or {}).get("name") or "Inventory Valuation"
    data = await compute_valuation(cid)

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    story = [
        Paragraph(company_name, s["Title2"]),
        Paragraph("INVENTORY VALUATION", s["SubTitle"]),
        Paragraph(f"As of {date.today().isoformat()} · Weighted-average costing", s["SubTitle"]),
        Spacer(1, 12),
    ]

    header = ["Item", "SKU", "Qty on hand", "Avg cost", "Value", "Account"]
    rows = [header]
    for r in data["rows"]:
        name = r["name"] + ("  ⚠ LOW" if r.get("low_stock") else "")
        rows.append([
            name,
            r.get("sku") or "—",
            f"{r['qoh']:,g}",
            f"${r['cost_basis']:,.4f}",
            f"${r['value']:,.2f}",
            (r.get("inventory_account_name") or "—")[:26],
        ])
    rows.append(["", "", "", "TOTAL", f"${data['total_value']:,.2f}", ""])

    if len(rows) == 1:
        story.append(Paragraph("No inventory-tracked items to report.", s["SubTitle"]))
    else:
        t = Table(rows, colWidths=[2.1 * inch, 0.9 * inch, 0.9 * inch, 1.0 * inch, 1.1 * inch, 1.3 * inch])
        t.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("ALIGN", (2, 1), (4, -1), "RIGHT"),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
        ]))
        story.append(t)

    low_stock_count = sum(1 for r in data["rows"] if r.get("low_stock"))
    if low_stock_count:
        story.append(Spacer(1, 12))
        story.append(Paragraph(
            f"⚠ {low_stock_count} item{'s' if low_stock_count != 1 else ''} at or below low-stock threshold.",
            s["SubTitle"],
        ))
    story.append(Spacer(1, 10))
    story.append(Paragraph(
        f"Total inventory value: <b>${data['total_value']:,.2f}</b> across {data['item_count']} tracked items.",
        s["SubTitle"],
    ))

    doc.build(story)
    return buf.getvalue()


# ── Reorder alerts ───────────────────────────────────────────────────

async def compute_reorder_alerts(cid: str) -> dict:
    """Every tracked item at or below its low-stock threshold. Powers
    the Dashboard "Reorder Alerts" tile and the one-click Draft PO
    action."""
    docs = await db.items.find({
        "company_id": cid, "track_inventory": True,
        "low_stock_threshold": {"$ne": None},
    }).to_list(2000)
    rows = []
    for it in docs:
        qoh = float(it.get("quantity_on_hand") or 0)
        threshold = float(it.get("low_stock_threshold") or 0)
        if qoh > threshold:
            continue
        rows.append({
            "item_id": it["id"],
            "name": it.get("name") or "",
            "sku": it.get("sku") or "",
            "qoh": round(qoh, 4),
            "threshold": round(threshold, 4),
            "cost_basis": round(float(it.get("cost_basis") or 0), 4),
            "suggested_reorder": max(1, round(threshold * 2 - qoh)),
            "expense_account_id": it.get("expense_account_id") or it.get("inventory_account_id"),
            "expense_account_name": it.get("expense_account_name") or it.get("inventory_account_name") or "",
        })
    rows.sort(key=lambda r: (r["qoh"] - r["threshold"], r["name"]))  # worst first
    return {"rows": rows, "count": len(rows)}
