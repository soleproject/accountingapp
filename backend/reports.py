"""Financial reports + PDF generation with a strict double-entry engine.

Storage convention (debit-normal / signed):
- Each transaction of amount `a` posts:
    bank_account   += a          (a>0 = money in = debit to asset)
    category_acct  += -a         (offsetting credit for a>0, or debit for a<0)
- Splits, if present, replace the single category leg (each split posts -split_amount).
- Journal entries post each line as (debit - credit) to that line's account_id.
- Under this convention, sum(all account raw balances) is always 0.

Display convention:
- Asset / Expense accounts show + when raw balance > 0 (debit-normal).
- Liability / Equity / Revenue accounts show + when raw balance < 0 (credit-normal),
  so we NEGATE their raw balance for display.
"""
from __future__ import annotations
import os
import logging
from io import BytesIO
from collections import defaultdict
from reportlab.lib.pagesizes import LETTER
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

from db import db

log = logging.getLogger(__name__)


# ────────────────────────────────────────────────────────────────
# Custom font registration
# ────────────────────────────────────────────────────────────────

# TTF families bundled at `backend/fonts/`. Each has a Regular + Bold
# static file (variable fonts were instanced at build time via
# `scripts/download_fonts.py`). Registered lazily on first import so a
# single process pays the load cost once; every subsequent PDF render
# hits ReportLab's in-memory glyph cache.
FONTS_DIR = os.path.join(os.path.dirname(__file__), "fonts")
_BUNDLED_FONTS = [
    "Inter", "Roboto", "OpenSans", "Nunito", "Poppins", "Lato",
    "PlayfairDisplay", "Lora", "LibreBaskerville", "PTSerif",
    "JetBrainsMono", "IBMPlexMono",
]


def _register_bundled_fonts() -> set[str]:
    """Register every bundled TTF with ReportLab. Returns the set of
    families that loaded successfully so the resolver can fall back to
    Helvetica if a file is ever missing at runtime."""
    ok: set[str] = set()
    for fam in _BUNDLED_FONTS:
        reg = os.path.join(FONTS_DIR, f"{fam}-Regular.ttf")
        bold = os.path.join(FONTS_DIR, f"{fam}-Bold.ttf")
        if not (os.path.isfile(reg) and os.path.isfile(bold)):
            log.warning("Report font %s missing (%s / %s) — skipping", fam, reg, bold)
            continue
        try:
            pdfmetrics.registerFont(TTFont(fam, reg))
            pdfmetrics.registerFont(TTFont(f"{fam}-Bold", bold))
            ok.add(fam)
        except Exception as e:  # noqa: BLE001 — TTF corruption shouldn't crash the app
            log.warning("Report font %s failed to load: %s", fam, e)
    return ok


AVAILABLE_FONTS = _register_bundled_fonts()


# ---------- Core: signed balance builder ----------

CREDIT_NORMAL = {"liability", "equity", "revenue"}


async def _has_qbo_gl_data(company_id: str) -> bool:
    """One-shot presence check: does this company have GL-lines
    populated? If yes, `_signed_balances` routes through the GL path
    which is guaranteed to match QBO by construction.

    Mongo `find_one` with a projection is O(1) with the
    `(company_id, date)` index; fastest gate we can put in front of
    the read path.
    """
    doc = await db.qbo_gl_lines.find_one(
        {"company_id": company_id}, {"_id": 1})
    return doc is not None


async def _signed_balances_from_gl(company_id: str, start: str | None,
                                     end: str,
                                     include_pre_period: bool = False,
                                     basis: str = "Accrual",
                                     class_id: str | None = None,
                                     project_id: str | None = None):
    """Return `{account_id: raw_signed_balance}` derived from QBO's
    own General Ledger rows stored in `qbo_gl_lines`.

    QBO's GL amount is signed toward the account's natural balance
    direction (positive when the account's balance increases in its
    natural side). Our storage convention is debit-positive, so:

    * Asset / Expense / COGS accounts: keep GL sign as-is.
    * Liability / Equity / Revenue: negate GL sign to match our
      debit-positive storage — display layer negates back to positive
      for user rendering (see `CREDIT_NORMAL` handling in
      `compute_balance_sheet`).

    Basis handling: `qbo_gl_lines` stores BOTH Accrual and Cash rows
    (tagged with `accounting_method` at pull time). Filter to the
    requested basis so cash-basis reports don't read accrual GL. The
    default "Accrual" mirrors what `run_migration()` used to pull
    single-basis, keeping older callers safe.

    Parent-account handling: QBO's `GeneralLedger` endpoint rolls
    child-account postings up into the parent's row set — but a
    parent can ALSO carry its own direct postings on top of that
    rollup. Naive per-account aggregation would double-count the
    child rollup portion. Fix: subtract the sum of each parent's
    direct children from the parent's own GL total so `by[parent_id]`
    reflects DIRECT-ONLY activity. The section-emit walker then
    correctly rolls children up separately. Emeral Coast Feb 28 2026
    — Jeep 2023 Gladiator White had $59,988 in both parent + child
    aggregations before this fix.
    """
    # Normalize basis so callers can pass "accrual"/"cash"/"Accrual".
    basis_norm = (basis or "Accrual").strip().lower()
    basis_tag = "Cash" if basis_norm == "cash" else "Accrual"

    # Build parent → children map from account docs. We'll subtract
    # child rollups after aggregating.
    parent_to_children: dict[str, list[str]] = {}
    async for a in db.accounts.find(
        {"company_id": company_id,
         "parent_account_id": {"$ne": None}},
        {"id": 1, "parent_account_id": 1},
    ):
        pid = a.get("parent_account_id")
        cid_ = a.get("id")
        if pid and cid_:
            parent_to_children.setdefault(pid, []).append(cid_)

    match: dict = {"company_id": company_id,
                    "accounting_method": basis_tag,
                    "date": {"$lte": end}}
    if start and not include_pre_period:
        match["date"] = {"$gte": start, "$lte": end}
    # Phase 1 (Feb 2026): optional postings-side filters. GL rows
    # imported from QBO carry `class_local_id` / `project_local_id`
    # when the source had `ClassRef` / project-typed CustomerRef.
    # When both filters are None (today's default), the query shape
    # is unchanged.
    if class_id:
        match["class_local_id"] = class_id
    if project_id:
        match["project_local_id"] = project_id

    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": {
                "account_local_id": "$account_local_id",
                "account_type": "$account_type",
            },
            "amount_sum": {"$sum": "$amount"},
        }},
    ]
    raw_by_acct: dict[str, tuple[float, str]] = {}  # id -> (sum, type)
    async for r in db.qbo_gl_lines.aggregate(pipeline):
        info = r["_id"]
        acct_id = info.get("account_local_id")
        if not acct_id:
            continue
        acct_type = (info.get("account_type") or "").lower()
        raw_by_acct[acct_id] = (
            float(r.get("amount_sum") or 0.0), acct_type)

    # Subtract each parent's child-rollup from the parent's GL sum
    # so `by[parent_id]` = parent's DIRECT postings only.
    parent_direct: dict[str, float] = {}
    for pid, kids in parent_to_children.items():
        parent_sum = raw_by_acct.get(pid, (0.0, ""))[0]
        kids_sum = sum(raw_by_acct.get(k, (0.0, ""))[0] for k in kids)
        parent_direct[pid] = parent_sum - kids_sum

    by: defaultdict = defaultdict(float)
    for acct_id, (gl_sum, acct_type) in raw_by_acct.items():
        # If this account is a parent, replace its raw sum with the
        # direct-only figure computed above.
        if acct_id in parent_direct:
            gl_sum = parent_direct[acct_id]
        # Flip credit-normal so this function returns the same
        # debit-positive shape as the legacy path.
        if acct_type in CREDIT_NORMAL:
            by[acct_id] = -gl_sum
        else:
            by[acct_id] = gl_sum
    return by


async def _signed_balances(company_id: str, start: str | None, end: str,
                            include_pre_period: bool = False,
                            basis: str = "Accrual",
                            imported_only: bool = False,
                            class_id: str | None = None,
                            project_id: str | None = None):
    """Return {account_id: raw_signed_balance} for postings whose date is <= end
    (and >= start if given and include_pre_period is False).

    Includes both transactions and journal entries. Both must be balanced sources.

    Phase 2 (Feb 28 2026): if this company has QBO GL data populated
    (via `run_migration` or `/api/admin/qbo/gl-migrate`), start from
    `_signed_balances_from_gl` for guaranteed parity with QBO's own
    reports.

    Phase 2c (Aug 23 2026): the GL is no longer the *only* source for
    QBO companies. Native activity created in Axiom AFTER migration
    (a manually-added invoice/bill/JE/txn that hasn't been mirrored
    back to QBO) is layered on top of the GL as an additive overlay.
    Every doc counts exactly once, in exactly one lane:
      • QBO-imported / mirrored-back-to-QBO  → GL lane
      • Native + not-yet-mirrored           → native lane
    See `_signed_balances_native_layer` for the source-filter guards
    that prevent double-counting.

    ``imported_only=True`` returns ONLY the QBO GL slice — used by the
    Reconciliation panel's "Imported QBO" column so we can prove the
    migration matches QBO exactly, and any drift vs OUR REPORT is
    100% attributable to native activity. Aug 23 2026.

    The `basis` argument is passed through so cash-basis reports
    read the Cash-tagged GL slice and accrual reports read the
    Accrual slice.

    Feb 2026 — advanced-features Phase 1: `class_id` / `project_id`
    are optional postings-side filters. When either is provided, only
    JE lines / transactions tagged with that class or project are
    counted. When both are None (today's default), zero query cost
    change — the underlying helpers skip the filter entirely.
    """
    has_gl = await _has_qbo_gl_data(company_id)
    if has_gl:
        # Start from the QBO GL (migrated + previously-mirrored activity).
        by = await _signed_balances_from_gl(
            company_id, start, end, include_pre_period, basis,
            class_id=class_id, project_id=project_id)
        if imported_only:
            return by
        # Layer native contributions on top. `skip_qbo_sourced=True`
        # filters out QBO-imported docs (already in the GL above) and
        # any native doc whose QBO twin now lives in `qbo_gl_lines`.
        native = await _signed_balances_native_layer(
            company_id, start, end, include_pre_period, basis,
            skip_qbo_sourced=True,
            class_id=class_id, project_id=project_id)
        by = defaultdict(float, by)
        for aid, delta in native.items():
            by[aid] += delta
        return by

    # Native / non-QBO company: run the native layer alone. ``imported_only``
    # has no meaning here — there's nothing to strip.
    return await _signed_balances_native_layer(
        company_id, start, end, include_pre_period, basis,
        skip_qbo_sourced=False,
        class_id=class_id, project_id=project_id)


async def _superseded_by_gl_ids(company_id: str) -> set[str]:
    """Return the set of local doc ids whose QBO twin already appears in
    `qbo_gl_lines` — for those, the native JE would double-count so we
    exclude it from the native overlay.

    Match is by `qbo_id` on the source doc against `doc_num` in the
    GL (QBO's GL rows carry the doc number, not the internal Id). This
    is stable enough for the auto-push+auto-pull happy path: when the
    mirror-push finishes, we stamp `qbo_id`; when the next GL backfill
    runs, the twin's `doc_num` shows up. Between those two events the
    native doc is still visible via the native lane, so there's no
    invisibility window.

    Returns an empty set if the company has no GL data (the caller
    should skip this entirely on native companies).
    """
    result: set[str] = set()
    # Only invoices, bills, and manually-posted JEs get mirrored back
    # to QBO today; payments/receipts share the invoice/bill lifecycle.
    coll_txn_type = [
        ("invoices", "Invoice"),
        ("bills", "Bill"),
        # QBO journal entries mirror as txn_type='Journal Entry'
        ("journal_entries", "Journal Entry"),
    ]
    for coll, _ in coll_txn_type:
        async for d in db[coll].find(
            {"company_id": company_id, "qbo_id": {"$ne": None},
             "_sync_status": "synced"},
            {"_id": 0, "id": 1, "qbo_id": 1},
        ):
            # We match by qbo_id below via a separate qbo_gl_lines lookup.
            result.add(d["id"])
    if not result:
        return result
    # For each candidate doc, keep it in the superseded set ONLY if its
    # qbo_id actually appears in qbo_gl_lines (i.e. the GL has been
    # refreshed since the mirror-push). Otherwise the native lane
    # still carries the doc.
    qbo_ids_in_gl: set[str] = set()
    async for row in db.qbo_gl_lines.find(
        {"company_id": company_id},
        {"_id": 0, "doc_num": 1, "txn_id": 1},
    ):
        for k in ("txn_id", "doc_num"):
            v = row.get(k)
            if v is not None:
                qbo_ids_in_gl.add(str(v))
    truly_superseded: set[str] = set()
    # Re-walk the candidates to keep only those whose qbo_id is in the GL.
    for coll, _ in coll_txn_type:
        async for d in db[coll].find(
            {"company_id": company_id, "qbo_id": {"$ne": None},
             "_sync_status": "synced"},
            {"_id": 0, "id": 1, "qbo_id": 1, "number": 1},
        ):
            qid = str(d.get("qbo_id") or "")
            num = str(d.get("number") or "")
            if qid in qbo_ids_in_gl or (num and num in qbo_ids_in_gl):
                truly_superseded.add(d["id"])
    return truly_superseded


async def _signed_balances_native_layer(
    company_id: str, start: str | None, end: str,
    include_pre_period: bool = False,
    basis: str = "Accrual",
    skip_qbo_sourced: bool = False,
    class_id: str | None = None,
    project_id: str | None = None,
):
    """Native ledger walk — the historic `_signed_balances` body, now
    extracted so it can be used both standalone (native companies) and
    as an additive overlay (QBO companies with post-migration native
    activity).

    When ``skip_qbo_sourced=True``:
      • ``transactions.source == 'qbo'`` → skipped (already in GL)
      • ``journal_entries.source in {'qbo', 'qbo_inv_adj'}`` → skipped
      • Any native doc whose QBO twin now lives in ``qbo_gl_lines``
        (see `_superseded_by_gl_ids`) → its JE and payment contributions
        are also skipped

    Phase 1 advanced features: `class_id` / `project_id` are optional
    postings-side filters. When set, only txns / JE lines carrying the
    matching FK are counted. Both None (today's default) → no filter,
    identical query cost.
    """
    by = defaultdict(float)
    superseded = await _superseded_by_gl_ids(company_id) if skip_qbo_sourced else set()

    txn_q = {"company_id": company_id, "posted": True, "date": {"$lte": end}}
    if start and not include_pre_period:
        txn_q["date"] = {"$gte": start, "$lte": end}
    if skip_qbo_sourced:
        txn_q["source"] = {"$ne": "qbo"}
    # Phase 1 optional filters. On a txn, the class/project FK lives at
    # the top level (single-project rule: one txn → one class/project).
    if class_id:
        txn_q["class_id"] = class_id
    if project_id:
        txn_q["project_id"] = project_id
    txns = await db.transactions.find(txn_q).to_list(100000)

    for t in txns:
        # QBO CreditMemos are a special case: their AR-reduction side is
        # tracked implicitly via `invoice.balance_due` (the linked invoice's
        # remaining balance is already reduced by the applied credit).
        # `_open_ar_ap` reads those reduced balances, so the CM's effect on
        # AR is already in NI via the accrual layer. Also posting the CM's
        # DR-to-Revenue line here would double-count the revenue reduction
        # (once via lower AR contribution to NI, once via direct signed
        # balance on the revenue account) and unbalance the BS by exactly
        # the CM total. Skip them here — the entity still shows up in
        # transaction lists / reports that read db.transactions directly.
        # Feb 26 2026 — see CHANGELOG QBO CM double-count fix.
        if t.get("txn_type") == "CreditMemo":
            continue
        # Non-posting entities (Estimate, PurchaseOrder,
        # RecurringTransaction) are stored in db.transactions purely
        # for the UI round-trip and are explicitly flagged
        # `posted=False`. They must NOT contribute to any signed
        # balance. Aug 22 2026 — non-posting round-trip.
        if t.get("posted") is False:
            continue

        amt = float(t.get("amount", 0) or 0)
        bank = t.get("bank_account_id")
        if bank:
            by[bank] += amt

        splits = t.get("splits") or []
        if splits:
            split_total = 0.0
            fallback_cat = t.get("category_account_id")
            for s in splits:
                sid = s.get("category_account_id") or s.get("account_id") or fallback_cat
                s_amt = float(s.get("amount", 0) or 0)
                split_total += s_amt
                if sid:
                    by[sid] += -s_amt
            # If splits don't cover the full amount, the remainder falls to the
            # primary category to keep the entry balanced.
            residual = amt - split_total
            aid_cat = t.get("category_account_id")
            if aid_cat and abs(residual) > 0.001:
                by[aid_cat] += -residual
        else:
            aid_cat = t.get("category_account_id")
            if aid_cat:
                by[aid_cat] += -amt

    je_q = {"company_id": company_id, "date": {"$lte": end}}
    if start and not include_pre_period:
        je_q["date"] = {"$gte": start, "$lte": end}
    # Cash-basis reports MUST NOT see accrual-only JEs (invoice-at-issue
    # revenue postings, bill-at-issue expense postings from
    # `posting_service`). Those recognize on the accrual axis only; the
    # cash P&L / BS uses direct cash movements + the allocation pass
    # in `compute_income_statement`. Feb 28 2026.
    if str(basis).lower() == "cash":
        je_q["posted_by"] = {"$ne": "auto_accrual"}
    # On QBO companies, filter out the JEs that are already represented
    # in `qbo_gl_lines`: (a) directly-imported QBO JEs, (b) QBO
    # inventory-adjustment JEs, (c) native JEs whose source doc has
    # been mirror-pushed and appears in the GL cache. Aug 23 2026.
    if skip_qbo_sourced:
        je_q["source"] = {"$nin": ["qbo", "qbo_inv_adj"]}
    # Phase 1 line-level filter — narrow to JEs that contain at least
    # one line matching the class/project. We still walk every line in
    # the doc below because a single JE can hit multiple projects; we
    # skip individual lines that don't match.
    if class_id:
        je_q["lines.class_id"] = class_id
    if project_id:
        je_q["lines.project_id"] = project_id
    jes = await db.journal_entries.find(je_q).to_list(100000)
    for j in jes:
        # Native JE whose source doc's QBO twin is now in the GL →
        # skip to avoid double-count.
        if skip_qbo_sourced and j.get("source_id") in superseded:
            continue
        for line in j.get("lines", []):
            # Per-line class/project filter: a JE can span projects and
            # only the matching lines should count when a filter is set.
            if class_id and line.get("class_id") != class_id:
                continue
            if project_id and line.get("project_id") != project_id:
                continue
            aid = line.get("account_id")
            d = float(line.get("debit", 0) or 0)
            c = float(line.get("credit", 0) or 0)
            if aid:
                by[aid] += (d - c)

    # ------------------------------------------------------------------
    # QBO Payment / BillPayment cash-side roll-in.
    #
    # Payments live in `db.payments` (not `db.transactions`) and QBO
    # tracks their AR/AP-reduction side implicitly by decrementing the
    # linked invoice/bill's `balance_due`. `_open_ar_ap` reads those
    # reduced balances so the AR/AP asset/liability figure is correct
    # post-payment — but the CASH side was previously never posted to
    # the ledger, so cash accounts under-reported all customer receipts
    # and vendor payouts.
    #
    # We roll payments in here so `_signed_balances` (and every report
    # built on top of it — BS/IS/GL/Cash Flow) sees the cash movement.
    # `compute_balance_sheet` mirrors the same total into Net Income
    # via a "realized-revenue" adjustment so the balance-sheet identity
    # (Assets = L + E) is preserved — see the payments_realized block
    # in compute_balance_sheet.
    # Feb 26 2026.
    # ------------------------------------------------------------------
    pay_q = {"company_id": company_id, "date": {"$lte": end}}
    if start and not include_pre_period:
        pay_q["date"] = {"$gte": start, "$lte": end}
    # On QBO companies, QBO-imported payments are already in the GL —
    # skip them here. Native payments still contribute their cash-side
    # roll-in (below) unless they've been mirror-pushed and appear in
    # the GL (superseded set). Aug 23 2026.
    if skip_qbo_sourced:
        pay_q["source"] = {"$ne": "qbo"}
    # Phase 1 (Feb 2026): a class/project filter is scoped to the
    # income-statement side (revenue/expense analysis per class/project).
    # Payment cash-side roll-ins don't carry a class/project directly —
    # skip them entirely when a filter is set so the returned map
    # reflects only classed/projected postings.
    filtered_view = bool(class_id or project_id)
    if filtered_view:
        pay_q["_skip_all"] = "__phase1_filter_bypass__"  # matches nothing
    # Prefetch account-by-qbo_id lookup for fast deposit-account resolution.
    acct_by_qbo_id: dict[str, str] = {}
    async for a in db.accounts.find({"company_id": company_id, "qbo_id": {"$ne": None}}):
        acct_by_qbo_id[str(a["qbo_id"])] = a["id"]

    # Company's Undeposited Funds account — used as fallback when a
    # customer payment has no explicit deposit destination. QBO models
    # this as a two-step workflow (Receive Payment → holds in Undep;
    # Bank Deposit → sweeps Undep into a bank), and Axiom mirrors it:
    # native payments recorded without a bank account default to Undep
    # so the Balance Sheet asset column still reflects the held cash.
    # Feb 28 2026 — Undeposited Funds workflow, Phase 2 QBO parity.
    undep_acct = await db.accounts.find_one({
        "company_id": company_id,
        # QBO's authoritative "this IS Undeposited Funds" signal is
        # `AccountSubType=UndepositedFunds`. Some CoAs also carry
        # unrelated `detail_type=money_in_transit` accounts (Stripe
        # Clearing, Payment Clearing, etc.) that would falsely match
        # a looser query — on BM QBO 2 LLC that non-determinism sent
        # all 47 sweep-from-UF deposits into Stripe Clearing instead
        # of UF, inflating both by $37k on the BS. Prefer subtype
        # first, fall back to the exact name only. Feb 27 2026.
        "$or": [{"subtype": {"$regex": "^UndepositedFunds$",
                              "$options": "i"}},
                {"name": {"$regex": "^Undeposited Funds$",
                          "$options": "i"}}],
    })
    undep_id = undep_acct["id"] if undep_acct else None

    def _pay_account_id(p: dict) -> str | None:
        """Resolve which local account this payment moves cash on.

        Resolution order:
          1. QBO: `deposit_account_qbo_id` (Payment.DepositToAccountRef,
             or BillPayment.CheckPayment/CreditCardPayment fallback in
             raw payload).
          2. Native: `deposit_to_account_id` (direct local id set by
             `POST /companies/{cid}/payments` — either explicitly by
             the user or auto-filled to Undeposited Funds).
          3. Fallback: None (caller applies the UF fallback for
             direction='in' payments, i.e. held-in-undeposited-funds).
        """
        qid = p.get("deposit_account_qbo_id")
        if not qid:
            raw = p.get("raw") or {}
            cp = raw.get("CheckPayment") or {}
            cc = raw.get("CreditCardPayment") or {}
            qid = ((cp.get("BankAccountRef") or {}).get("value")
                   or (cc.get("CCAccountRef") or {}).get("value"))
        if qid:
            return acct_by_qbo_id.get(str(qid))
        # Native path — the local account id lives directly on the doc.
        return p.get("deposit_to_account_id") or None

    async for p in db.payments.find(pay_q):
        # Native payment whose linked invoice/bill now lives in the
        # GL → skip so its cash-side roll-in doesn't double-count.
        if skip_qbo_sourced:
            linked_id = p.get("linked_invoice_id") or p.get("linked_bill_id")
            if linked_id and linked_id in superseded:
                continue
        amt = float(p.get("amount") or 0)
        if amt <= 0.005:
            continue
        # Native payments paired with a bank transaction already have
        # the cash side posted via that txn's `bank_account_id` — the
        # payment doc is purely for AR/AP reduction. Posting the
        # payment too would double-count both sides of the ledger,
        # unbalancing the BS by exactly the payment amount.
        if p.get("source") != "qbo" and p.get("source_transaction_id"):
            continue
        # Native payments posted via `posting_service.post_payment_je`
        # already have both cash + AR/AP legs sitting in
        # `journal_entries` (rolled up at line 272 above). Rolling
        # the cash side in here too would double-count. Only skip on
        # ACCRUAL basis — on cash basis the JE is filtered out of the
        # roll-in above (auto_accrual JEs excluded from cash reports),
        # so we still need this block to surface the cash side.
        # QBO-sourced payments never post local JEs so they always
        # flow through this block. Feb 28 2026.
        if (p.get("posted") is True
                and p.get("source") != "qbo"
                and str(basis).lower() != "cash"):
            continue
        aid = _pay_account_id(p)
        direction = p.get("direction") or "in"
        # Direction='in' with no resolvable deposit account →
        # Undeposited Funds. Preserves the BS identity: the invoice's
        # `balance_due` was already reduced (AR down by amt), so we
        # need SOMETHING on the asset side up by amt or the sheet
        # unbalances. Held-in-UF is the QBO-compliant answer.
        if not aid and direction == "in" and undep_id:
            aid = undep_id
        if not aid:
            continue
        if direction == "in":
            # DR the deposit account (bank/undep) — cash goes up.
            by[aid] += amt
        else:
            # BillPayment OUT: CR the funding account — cash goes down
            # (or, for CC-funded bill payments, the CC liability goes up
            # because raw signed balance on a credit-card LIABILITY
            # account is stored negative; `_display_amount` inverts it).
            by[aid] += -amt

    return by


def _display_amount(acct: dict, raw: float) -> float:
    """Return display amount (positive = normal balance)."""
    if acct["type"] in CREDIT_NORMAL:
        return -raw
    return raw


# ---------- Accrual helpers (A/R and A/P from open invoices / bills) ----------

async def _open_ar_ap(company_id: str, as_of: str, start: str | None = None):
    """Compute Accounts Receivable and Accounts Payable balances driven by
    open (unpaid) invoices/bills as of a date.

    Returns dict with:
      - ar_end / ap_end: totals of unpaid balances for docs issued on/before `as_of`
      - ar_start / ap_start: same but as of the day before `start` (0 if start is None)
      - ar_billed_in_period / ap_billed_in_period: total invoiced/billed
        (regardless of payment) during [start, end] — used for accrual P&L
      - ar_cash_in_period / ap_cash_in_period: cash received against invoices /
        cash paid against bills during [start, end] — needed to reconcile
    """
    from datetime import date as _date

    # Once an invoice/bill has been posted as a real JE (via
    # `posting_service.post_invoice_je` / `post_bill_je` on
    # create), the JE drives A/R and A/P in the report — the
    # synthesis below would double-count. Skip posted docs.
    # Feb 28 2026.
    #
    # QBO-imported invoices/bills (source='qbo') are also excluded on
    # companies with `qbo_gl_lines` because those docs already carry
    # A/R and A/P through the GL. This helper is called from
    # compute_balance_sheet even for QBO companies now (as part of the
    # additive-native overlay) so it must filter out QBO-sourced docs
    # there. Aug 23 2026.
    doc_query_extra: dict = {}
    if await _has_qbo_gl_data(company_id):
        doc_query_extra["source"] = {"$ne": "qbo"}
    invs = await db.invoices.find({
        "company_id": company_id,
        "posted": {"$ne": True},
        **doc_query_extra,
    }).to_list(20000)
    bills = await db.bills.find({
        "company_id": company_id,
        "posted": {"$ne": True},
        **doc_query_extra,
    }).to_list(20000)

    ar_end = 0.0
    ap_end = 0.0
    ar_start = 0.0
    ap_start = 0.0
    ar_billed_in_period = 0.0
    ap_billed_in_period = 0.0
    ar_by_account: dict[str, float] = {}
    ap_by_account: dict[str, float] = {}

    # Inventory-tracked bill lines already sit on the balance sheet
    # via `DR Inventory / CR A/P` journal entries posted by
    # `inventory_service.apply_bill_inventory`. Counting them AGAIN in
    # ap_billed_in_period / ap_end would double-book the same $ against
    # A/P (once from the JE, once from this helper) and drop a phantom
    # -expense into the Income Statement. We total the inventory
    # portion per-bill here and subtract it from the accrual figures
    # below.
    inv_bill_portion: dict[str, float] = {}
    async for je in db.journal_entries.find({
        "company_id": company_id, "source": "bill_inventory",
        "ref_kind": "bill",
    }):
        rid = je.get("ref_id")
        if not rid:
            continue
        # Sum credits to A/P for this bill (belt-and-braces if
        # `inventory_portion` isn't stored on older JEs).
        portion = float(je.get("inventory_portion") or 0.0)
        if not portion:
            portion = sum(float(l.get("credit") or 0) for l in (je.get("lines") or []))
        inv_bill_portion[rid] = inv_bill_portion.get(rid, 0.0) + portion

    def _in_period(d: str) -> bool:
        if not start:
            return False
        return d >= start and d <= as_of

    # "Prior day" of start for opening-balance calculation
    prev_end = None
    if start:
        try:
            sd = _date.fromisoformat(start)
            prev_end = _date.fromordinal(sd.toordinal() - 1).isoformat()
        except Exception:
            prev_end = start

    for i in invs:
        issue = i.get("issue_date") or ""
        total = float(i.get("total", 0) or 0)
        bal = float(i.get("balance_due", 0) or 0)
        ar_qid = str(((i.get("raw") or {}).get("ARAccountRef") or {}).get("value") or "")
        if issue and issue <= as_of and bal > 0.005:
            ar_end += bal
            if ar_qid:
                ar_by_account[ar_qid] = ar_by_account.get(ar_qid, 0.0) + bal
        if prev_end and issue and issue <= prev_end and bal > 0.005:
            # Rough approximation: use current balance_due as a snapshot proxy.
            # If total==bal (unpaid) we count it fully; partially-paid may
            # slightly under-state opening A/R but the drift is small.
            ar_start += bal
        if _in_period(issue):
            ar_billed_in_period += total

    for b in bills:
        issue = b.get("issue_date") or ""
        total = float(b.get("total", 0) or 0)
        bal = float(b.get("balance_due", 0) or 0)
        ap_qid = str(((b.get("raw") or {}).get("APAccountRef") or {}).get("value") or "")
        # Inventory-tracked portion already booked as A/P via JE — pull
        # it out of every accrual figure so we don't count it twice.
        inv_portion = float(inv_bill_portion.get(b.get("id"), 0.0))
        # ap_end/ap_start use balance_due, not total; scale the inv
        # portion by the paid-ratio so a partly-paid bill still nets
        # right (e.g. 50% paid → only 50% of the JE-booked A/P is still
        # open, rest is already relieved by the payment txn).
        open_ratio = (bal / total) if total > 0.005 else 0.0
        open_inv_portion = inv_portion * open_ratio
        if issue and issue <= as_of and bal > 0.005:
            open_bill_net = max(bal - open_inv_portion, 0.0)
            ap_end += open_bill_net
            if ap_qid:
                ap_by_account[ap_qid] = ap_by_account.get(ap_qid, 0.0) + open_bill_net
        if prev_end and issue and issue <= prev_end and bal > 0.005:
            ap_start += max(bal - open_inv_portion, 0.0)
        if _in_period(issue):
            ap_billed_in_period += max(total - inv_portion, 0.0)

    return {
        "ar_end": round(ar_end, 2), "ap_end": round(ap_end, 2),
        "ar_start": round(ar_start, 2), "ap_start": round(ap_start, 2),
        "ar_billed_in_period": round(ar_billed_in_period, 2),
        "ap_billed_in_period": round(ap_billed_in_period, 2),
        # Per-account bucketing so `compute_balance_sheet` can fold each
        # AR/AP total into the correct GL account row (bills post to
        # `APAccountRef`, invoices to `ARAccountRef`). Only populated
        # for QBO-imported docs — native ones default to unspecified
        # and fall through to the caller's primary-account fallback.
        # Feb 27 2026 — see BM QBO 2 LLC parity fix.
        "ar_by_account_qbo_id": {k: round(v, 2) for k, v in ar_by_account.items()},
        "ap_by_account_qbo_id": {k: round(v, 2) for k, v in ap_by_account.items()},
    }


# ---------- Income Statement ----------

async def compute_income_statement(company_id: str, start: str, end: str, basis: str = "accrual",
                                   imported_only: bool = False):
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    by = await _signed_balances(company_id, start, end, basis=basis,
                                 imported_only=imported_only)

    # Phase 2 (Feb 28 2026): when GL rows are the source of truth,
    # every accrual / cash-basis compensating layer below (invoice
    # revenue roll-in, bill expense roll-in, cash allocation from
    # payments) would DOUBLE-COUNT on top of the GL. Skip them
    # entirely for GL-authoritative companies.
    #
    # ``imported_only`` requests the "QBO-imported slice" view for
    # the Reconciliation panel; native activity must also be skipped
    # for that view — the panel's "+ NATIVE" column surfaces those
    # numbers separately. Aug 23 2026.
    _gl_authoritative = await _has_qbo_gl_data(company_id)
    _skip_native_layer = _gl_authoritative or imported_only

    # Build parent → children index (same pattern used on the balance
    # sheet). Sub-accounts render indented under their parent and the
    # parent shows the rolled-up total (own direct postings + kids).
    children_of: dict[str, list[dict]] = {}
    for a in accts:
        pid = a.get("parent_account_id")
        if pid:
            children_of.setdefault(pid, []).append(a)

    def _emit(section_type: str):
        """Return the flat row list for one P&L section. Callers pair
        this with `_sum_section(rows)` to get the correctly-rolled
        total — re-summing here would double-count subtotal rows."""
        rows: list[dict] = []
        top_level = [a for a in accts
                     if a["type"] == section_type and not a.get("parent_account_id")]
        # Sort by (detail_type, code) so accounts sharing a Wave-style
        # sub-type end up contiguous — required for the grouped
        # renderer to emit clean sub-type banners in the PDF.
        top_level.sort(key=lambda x: ((x.get("detail_type") or "zzz").lower(), (x.get("code") or "")))
        for a in top_level:
            direct = _display_amount(a, by.get(a["id"], 0.0))
            kids = sorted(children_of.get(a["id"], []), key=lambda x: x["code"])
            kids_rows: list[dict] = []
            kids_total = 0.0
            for k in kids:
                if k["type"] != section_type:
                    continue
                kd = _display_amount(k, by.get(k["id"], 0.0))
                if abs(kd) < 0.005:
                    continue
                kids_rows.append({
                    "id": k["id"], "code": k["code"], "name": k["name"],
                    "amount": round(kd, 2),
                    "parent_code": a["code"],
                    "parent_id": a["id"],  # authoritative link (code is
                                            # often "" for QBO accounts)
                    "detail_type": (k.get("detail_type") or "").strip(),
                })
                kids_total += kd
            rolled = direct + kids_total
            # QBO's report convention: parent row shows ONLY its own direct
            # postings; children listed indented; then a "Total {parent}"
            # subtotal row that equals direct + children. This is the same
            # shape QBO's own P&L renders, so the reconciliation panel can
            # match rows label-to-label.
            if abs(rolled) < 0.005:
                # Parent is truly zero and no active children: skip.
                for kr in kids_rows:
                    rows.append(kr)
                continue
            # Emit parent (direct-only)
            if abs(direct) >= 0.005 or kids_rows:
                rows.append({
                    "id": a["id"], "code": a["code"], "name": a["name"],
                    "amount": round(direct, 2),
                    "detail_type": (a.get("detail_type") or "").strip(),
                })
            rows.extend(kids_rows)
            # Emit "Total X" subtotal only when there are children — matches QBO.
            if kids_rows:
                rows.append({
                    "id": f"{a['id']}__subtotal", "code": "",
                    "name": f"Total {a['name']}",
                    "amount": round(rolled, 2),
                    "parent_code": a["code"],
                    "parent_id": a["id"],  # links subtotal to its parent
                                            # so `_refresh_subtotals` can
                                            # find it via id even when
                                            # the parent code is "".
                    "is_subtotal": True,
                    "detail_type": (a.get("detail_type") or "").strip(),
                })
        return rows

    revenue_rows = _emit("revenue")
    cogs_rows    = _emit("cogs")
    expense_rows = _emit("expense")

    # `_emit` only walks parent + direct children. Any grandchild (or
    # deeper) account with non-zero raw signed activity (typically a
    # Purchase categorized to a leaf-level revenue account, which QBO
    # subtracts from that leaf's income total) gets dropped. Sweep in
    # a flat row for every remaining non-zero account so the P&L
    # reflects deep-level activity.
    # Feb 28 2026 — QBO Phase 2 parity, closes the last ~$79 Takeout
    # / Food & Beverage Sales drift on QBO Test 553 LLC.
    def _sweep_deep_accounts(section_type: str, rows: list[dict]) -> list[dict]:
        seen_ids = {r["id"] for r in rows if r.get("id") and not r.get("is_subtotal")}
        for a in accts:
            if a["type"] != section_type:
                continue
            if a["id"] in seen_ids:
                continue
            direct = _display_amount(a, by.get(a["id"], 0.0))
            if abs(direct) < 0.005:
                continue
            rows.append({
                "id": a["id"], "code": a.get("code") or "",
                "name": a["name"],
                "amount": round(direct, 2),
                "detail_type": (a.get("detail_type") or "").strip(),
            })
        return rows
    revenue_rows = _sweep_deep_accounts("revenue", revenue_rows)
    cogs_rows    = _sweep_deep_accounts("cogs",    cogs_rows)
    expense_rows = _sweep_deep_accounts("expense", expense_rows)

    # Shared subtotal refresher — used by both the accrual and the
    # cash allocation passes. `_emit` created the subtotal at
    # emit-time using the pre-adjustment `rolled = direct + kids`
    # value, but subsequent layers (accrual invoice/bill top-ups,
    # cash-basis payment prorations) subsequently topped up each
    # kid row with its share of the period's activity — the subtotal
    # doesn't auto-recompute, so "Total Legal & Professional Fees"
    # stayed at emit-time $480 instead of the post-accrual $1,170.
    # Feb 28 2026 — Craig's Landscaping P&L subtotal drift.
    def _refresh_subtotals(rows):
        # Build maps keyed by parent_id (authoritative — QBO
        # accounts routinely have `code = ""`, so relying on
        # `parent_code` alone missed 100% of QBO-imported groupings).
        child_sum_by_parent: dict[str, float] = {}
        parent_direct_by_id: dict[str, float] = {}
        for r in rows:
            if r.get("is_subtotal"):
                continue
            pid = r.get("parent_id")
            if pid:
                child_sum_by_parent[pid] = (
                    child_sum_by_parent.get(pid, 0.0) + r["amount"])
            elif r.get("id"):
                parent_direct_by_id[r["id"]] = r["amount"]
        for r in rows:
            if not r.get("is_subtotal"):
                continue
            pid = r.get("parent_id")
            if not pid:
                continue
            new_total = (parent_direct_by_id.get(pid, 0.0)
                         + child_sum_by_parent.get(pid, 0.0))
            r["amount"] = round(new_total, 2)

    # Section totals — sum every row that is NOT a "Total X" subtotal.
    # Because parent rows are now direct-only and children carry their
    # own amounts, adding all non-subtotal rows equals the true total
    # (no double-counting).
    def _sum_section(rows):
        return round(sum(r["amount"] for r in rows if not r.get("is_subtotal")), 2)
    total_revenue = _sum_section(revenue_rows)
    total_cogs    = _sum_section(cogs_rows)
    total_expense = _sum_section(expense_rows)

    # Accrual layer: on QBO's own P&L, revenue is recognized when an
    # invoice is issued (regardless of whether it's been collected).
    # Our raw signed-balances layer only counts direct posts to revenue
    # accounts (SalesReceipts, RefundReceipts, JEs) — invoice-driven
    # revenue lives in `db.invoices`, never touching `_signed_balances`.
    # Same shape for A/P: bills issued in the period are the accrual
    # expense.
    #
    # To match QBO's per-account totals we:
    #   1. Walk each invoice/bill issued in the period
    #   2. Group its line items by the income/expense account each
    #      item points at (via `account_qbo_id` on the mapped line)
    #   3. Fold those amounts into the revenue/expense row for the
    #      matching account, or emit a synthetic bucket row when the
    #      line has no resolvable account (falls back to a single
    #      "Uncategorized Income / Expense" catch-all so totals still
    #      tie).
    #
    # Feb 26 2026 — replaces the earlier flat "Accrual adjustment
    # (Δ A/R)" line which under-counted by `ar_cash_in_period` and
    # prevented per-account reconciliation with QBO.
    accrual_adj_rev = 0.0
    accrual_adj_exp = 0.0
    if basis == "accrual" and not _gl_authoritative:
        rev_by_qbo: dict[str, dict] = {}
        exp_by_qbo: dict[str, dict] = {}
        for a in accts:
            if a.get("qbo_id"):
                if a["type"] == "revenue":
                    rev_by_qbo[str(a["qbo_id"])] = a
                elif a["type"] in ("expense", "cogs"):
                    exp_by_qbo[str(a["qbo_id"])] = a
        # Also index the rows we already emitted so we can add to
        # them in place instead of stacking duplicate entries.
        rev_row_by_id = {r["id"]: r for r in revenue_rows if r.get("id")}
        exp_row_by_id = {r["id"]: r for r in expense_rows if r.get("id")}

        # 1) Invoices issued in the period → revenue side.
        # Posted invoices (JEs auto-written by `posting_service`) already
        # drive their income account through `_signed_balances`'s JE
        # roll-in, so we must skip them here to avoid double-counting.
        # Feb 28 2026.
        rev_uncategorized = 0.0
        async for inv in db.invoices.find({"company_id": company_id}):
            if inv.get("posted") is True:
                continue
            issue = inv.get("issue_date") or ""
            if not (issue and start <= issue <= end):
                continue
            for ln in inv.get("line_items") or []:
                amt = float(ln.get("amount") or 0)
                if abs(amt) < 0.005:
                    continue
                qid = str(ln.get("account_qbo_id") or "")
                # Common pattern: SalesItemLineDetail carries an
                # ItemRef (not AccountRef). Look up the item's income
                # account when we didn't get an AccountRef directly.
                if not qid and ln.get("item_qbo_id"):
                    item = await db.items.find_one({
                        "company_id": company_id,
                        "qbo_id": ln["item_qbo_id"]})
                    if item:
                        qid = str(item.get("income_account_qbo_id") or "")
                acct = rev_by_qbo.get(qid)
                if acct:
                    row = rev_row_by_id.get(acct["id"])
                    if row:
                        row["amount"] = round(row["amount"] + amt, 2)
                    else:
                        new_row = {
                            "id": acct["id"], "code": acct.get("code") or "",
                            "name": acct.get("name") or "",
                            "amount": round(amt, 2),
                            "detail_type": (acct.get("detail_type") or "").strip(),
                        }
                        revenue_rows.append(new_row)
                        rev_row_by_id[acct["id"]] = new_row
                else:
                    rev_uncategorized += amt
                accrual_adj_rev += amt
        if abs(rev_uncategorized) >= 0.005:
            revenue_rows.append({
                "code": "4999",
                "name": "Uncategorized Income (accrual)",
                "amount": round(rev_uncategorized, 2),
            })

        # 1b) CreditMemos issued in the period → NEGATE the revenue
        #     line. QBO's P&L subtracts CMs from the target income
        #     account (Pest Control -$100 on QBO Test 553 LLC's CM
        #     1026). Without this pass, our accrual revenue over-
        #     counts by the CM total because `_open_ar_ap` already
        #     applied the CM to invoice.balance_due (AR reduction)
        #     but the revenue side stayed at the original invoiced
        #     amount. RefundReceipts are already handled in
        #     `_signed_balances` (they carry a negative txn amount
        #     that credits the revenue account directly) — we
        #     deliberately skip them here to avoid double-counting.
        #     Feb 28 2026 — QBO Phase 2 parity.
        async for cm in db.transactions.find({
            "company_id": company_id, "source": "qbo",
            "txn_type": "CreditMemo",
        }):
            date = cm.get("date") or ""
            if not (date and start <= date <= end):
                continue
            for ln in cm.get("line_items") or []:
                amt = float(ln.get("amount") or 0)
                if abs(amt) < 0.005:
                    continue
                qid = str(ln.get("account_qbo_id") or "")
                if not qid and ln.get("item_qbo_id"):
                    item = await db.items.find_one({
                        "company_id": company_id,
                        "qbo_id": ln["item_qbo_id"]})
                    if item:
                        qid = str(item.get("income_account_qbo_id") or "")
                acct = rev_by_qbo.get(qid)
                # CM/RR reduce revenue → subtract the line amount.
                if acct:
                    row = rev_row_by_id.get(acct["id"])
                    if row:
                        row["amount"] = round(row["amount"] - amt, 2)
                    else:
                        new_row = {
                            "id": acct["id"], "code": acct.get("code") or "",
                            "name": acct.get("name") or "",
                            "amount": round(-amt, 2),
                            "detail_type": (acct.get("detail_type") or "").strip(),
                        }
                        revenue_rows.append(new_row)
                        rev_row_by_id[acct["id"]] = new_row
                # Negate the accrual adjustment so BS math tracks: the
                # CM's AR-reduction side already flowed through
                # `_open_ar_ap`, so pairing this NI reduction keeps
                # Assets = L + E.
                accrual_adj_rev -= amt

        # 2) Bills issued in the period → expense/COGS side.
        # Skip posted bills — JE roll-in already covers their expense
        # side. Feb 28 2026.
        exp_uncategorized = 0.0
        async for bill in db.bills.find({"company_id": company_id}):
            if bill.get("posted") is True:
                continue
            issue = bill.get("issue_date") or ""
            if not (issue and start <= issue <= end):
                continue
            for ln in bill.get("line_items") or []:
                amt = float(ln.get("amount") or 0)
                if abs(amt) < 0.005:
                    continue
                qid = str(ln.get("account_qbo_id") or "")
                if not qid and ln.get("item_qbo_id"):
                    item = await db.items.find_one({
                        "company_id": company_id,
                        "qbo_id": ln["item_qbo_id"]})
                    if item:
                        qid = str(item.get("expense_account_qbo_id") or "")
                acct = exp_by_qbo.get(qid)
                if acct:
                    if acct["type"] == "cogs":
                        target_rows = cogs_rows
                    else:
                        target_rows = expense_rows
                    row = next((r for r in target_rows if r.get("id") == acct["id"]), None)
                    if row:
                        row["amount"] = round(row["amount"] + amt, 2)
                    else:
                        target_rows.append({
                            "id": acct["id"], "code": acct.get("code") or "",
                            "name": acct.get("name") or "",
                            "amount": round(amt, 2),
                            "detail_type": (acct.get("detail_type") or "").strip(),
                        })
                else:
                    exp_uncategorized += amt
                accrual_adj_exp += amt
        if abs(exp_uncategorized) >= 0.005:
            expense_rows.append({
                "code": "5999",
                "name": "Uncategorized Expense (accrual)",
                "amount": round(exp_uncategorized, 2),
            })

        # Recompute section totals now that accrual rows have been
        # merged into the per-account rows. Use `_sum_section` (which
        # only skips `is_subtotal` rows) so parent-direct + child
        # amounts add up correctly. The old logic skipped `parent_code`
        # rows too, which under-counted totals by the parent-direct
        # amount every time a parent had children (e.g. Legal &
        # Professional Fees' $75 direct + child totals were lost).
        total_revenue = _sum_section(revenue_rows)
        total_cogs    = _sum_section(cogs_rows)
        total_expense = _sum_section(expense_rows)

        # Refresh "Total X" subtotal rows so they reflect the child
        # amounts after the accrual pass.
        _refresh_subtotals(revenue_rows)
        _refresh_subtotals(cogs_rows)
        _refresh_subtotals(expense_rows)

    elif basis == "cash" and not _gl_authoritative:
        # ------------------------------------------------------------------
        # Cash-basis allocation (Feb 28 2026 — Craig's Landscaping parity)
        # ------------------------------------------------------------------
        # On cash basis, revenue and expense recognize when MONEY MOVES,
        # not when the invoice/bill is issued. `_signed_balances` already
        # captures direct cash txns (SalesReceipt, RefundReceipt, Purchase,
        # Check, Deposit-with-revenue-category), but any invoice paid by
        # a Payment doc contributes nothing without an explicit
        # allocation pass — we'd under-count revenue by the amount of
        # every paid invoice's line items.
        #
        # Allocation rule (matches QBO):
        #   For each Payment (direction='in') dated in the period, split
        #   the payment amount across the linked invoice's line items
        #   in proportion to each line's contribution to the invoice
        #   subtotal, then post that slice to the line's income account.
        #   Symmetrical for direction='out' + bill lines → expense/COGS.
        rev_by_qbo: dict[str, dict] = {}
        exp_by_qbo: dict[str, dict] = {}
        for a in accts:
            if a.get("qbo_id"):
                if a["type"] == "revenue":
                    rev_by_qbo[str(a["qbo_id"])] = a
                elif a["type"] in ("expense", "cogs"):
                    exp_by_qbo[str(a["qbo_id"])] = a

        rev_row_by_id = {r["id"]: r for r in revenue_rows if r.get("id")}
        exp_row_by_id = {r["id"]: r for r in expense_rows if r.get("id")}
        cogs_row_by_id = {r["id"]: r for r in cogs_rows if r.get("id")}

        def _add_to(section: str, acct: dict, amt: float):
            """Increment (or create) the P&L row for `acct` by `amt`.
            Handles parent_id linkage so `_refresh_subtotals` finds
            it. Idempotent per account id."""
            if section == "revenue":
                idx, target_rows = rev_row_by_id, revenue_rows
            elif section == "cogs":
                idx, target_rows = cogs_row_by_id, cogs_rows
            else:
                idx, target_rows = exp_row_by_id, expense_rows
            row = idx.get(acct["id"])
            if row:
                row["amount"] = round(row["amount"] + amt, 2)
                return
            new_row = {
                "id": acct["id"], "code": acct.get("code") or "",
                "name": acct.get("name") or "",
                "amount": round(amt, 2),
                "detail_type": (acct.get("detail_type") or "").strip(),
            }
            if acct.get("parent_account_id"):
                new_row["parent_id"] = acct["parent_account_id"]
            target_rows.append(new_row)
            idx[acct["id"]] = new_row

        # --- 1) Customer payments → revenue (top-down invoice-line
        #        application, matching QBO's cash-basis behaviour).
        #
        # QBO applies partial payments in LINE ORDER — the payment
        # consumes each line's full amount top-to-bottom until the
        # payment is exhausted. Prior implementation prorated the
        # payment across all lines by ratio, which agrees with QBO
        # on fully-paid invoices but drifts on partial payments
        # (Sandbox 358d Craig's Landscaping was over by $120.52 on
        # Cash Total Income due to this).
        # Feb 28 2026 — Cash-basis parity, top-down allocation.
        #
        # Multi-payment fix (Aug 21 2026): allocating each payment
        # independently against `lines` re-consumed the top lines and
        # never reached the bottom on invoices paid by more than one
        # deposit. Group payments per invoice, then walk lines once
        # with a cumulative consumption pointer split into
        # pre-period (outside window, advances pointer only) and
        # in-period (attributes to revenue). Sandbox 358d: Invoice
        # 1004 has P1=$694 + P2=$1,675.52 → prior code posted
        # Sprinklers $88 (2×) and Sod $2,281.52 (2×) while Services
        # $400 was never reached; multi-payment invoices drove the
        # shuffle pattern on the cash-P&L Recon Panel.
        inv_prepay: dict[str, float] = {}
        inv_inpay:  dict[str, float] = {}
        async for pay in db.payments.find({"company_id": company_id,
                                            "direction": "in"}):
            inv_id = pay.get("linked_invoice_id")
            if not inv_id:
                continue
            paid = float(pay.get("amount") or 0)
            if paid < 0.005:
                continue
            d = pay.get("date") or ""
            if not d:
                continue
            if d < start:
                inv_prepay[inv_id] = inv_prepay.get(inv_id, 0.0) + paid
            elif d <= end:
                inv_inpay[inv_id] = inv_inpay.get(inv_id, 0.0) + paid

        for inv_id, in_paid in inv_inpay.items():
            inv = await db.invoices.find_one({"id": inv_id,
                                                "company_id": company_id})
            if not inv:
                continue
            lines = inv.get("line_items") or []
            remaining_pre = inv_prepay.get(inv_id, 0.0)
            remaining_in  = in_paid
            for ln in lines:
                la = float(ln.get("amount") or 0)
                if abs(la) < 0.005:
                    continue
                # Pre-period consumption advances the pointer without
                # posting revenue (those payments already recognized
                # in a prior period).
                pre_consumed = min(la, remaining_pre) if la > 0 else 0.0
                remaining_pre -= pre_consumed
                line_remaining = la - pre_consumed
                if line_remaining < 0.005 and la > 0:
                    continue
                # In-period portion posts to the line's account.
                if remaining_in <= 0.005:
                    break
                in_consumed = round(min(line_remaining, remaining_in), 2)
                remaining_in -= in_consumed
                qid = str(ln.get("account_qbo_id") or "")
                acct = rev_by_qbo.get(qid)
                if not acct:
                    # Line points somewhere we can't classify as
                    # revenue (a Discount line, or a line whose GL
                    # stamp landed on an expense) — consumed above so
                    # subsequent revenue lines get the correct
                    # residual.
                    continue
                if in_consumed < 0.005:
                    continue
                _add_to("revenue", acct, in_consumed)

        # --- 2) Vendor payments → expense/COGS (top-down bill-line
        #        application, matching QBO's cash-basis behaviour).
        # Same multi-payment fix as the customer side (Aug 21 2026).
        bill_prepay: dict[str, float] = {}
        bill_inpay:  dict[str, float] = {}
        async for pay in db.payments.find({"company_id": company_id,
                                            "direction": "out"}):
            bill_id = pay.get("linked_bill_id")
            if not bill_id:
                continue
            paid = float(pay.get("amount") or 0)
            if paid < 0.005:
                continue
            d = pay.get("date") or ""
            if not d:
                continue
            if d < start:
                bill_prepay[bill_id] = bill_prepay.get(bill_id, 0.0) + paid
            elif d <= end:
                bill_inpay[bill_id] = bill_inpay.get(bill_id, 0.0) + paid

        for bill_id, in_paid in bill_inpay.items():
            bill = await db.bills.find_one({"id": bill_id,
                                              "company_id": company_id})
            if not bill:
                continue
            lines = bill.get("line_items") or []
            remaining_pre = bill_prepay.get(bill_id, 0.0)
            remaining_in  = in_paid
            for ln in lines:
                la = float(ln.get("amount") or 0)
                if abs(la) < 0.005:
                    continue
                pre_consumed = min(la, remaining_pre) if la > 0 else 0.0
                remaining_pre -= pre_consumed
                line_remaining = la - pre_consumed
                if line_remaining < 0.005 and la > 0:
                    continue
                if remaining_in <= 0.005:
                    break
                in_consumed = round(min(line_remaining, remaining_in), 2)
                remaining_in -= in_consumed
                qid = str(ln.get("account_qbo_id") or "")
                if not qid and ln.get("item_qbo_id"):
                    item = await db.items.find_one({
                        "company_id": company_id,
                        "qbo_id": ln["item_qbo_id"]})
                    if item:
                        qid = str(item.get("expense_account_qbo_id") or "")
                acct = exp_by_qbo.get(qid)
                if not acct:
                    continue
                if in_consumed < 0.005:
                    continue
                _add_to("cogs" if acct["type"] == "cogs" else "expense",
                        acct, in_consumed)

        total_revenue = _sum_section(revenue_rows)
        total_cogs    = _sum_section(cogs_rows)
        total_expense = _sum_section(expense_rows)
        _refresh_subtotals(revenue_rows)
        _refresh_subtotals(cogs_rows)
        _refresh_subtotals(expense_rows)

    # Gross Profit = Revenue − COGS. Emitted as a subtotal above
    # Operating Expenses whenever there's any COGS activity.
    gross_profit = round(total_revenue - total_cogs, 2)
    net_income   = round(gross_profit - total_expense, 2)

    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end, "basis": basis,
        "revenue": revenue_rows,
        "cogs": cogs_rows,
        "expenses": expense_rows,
        "total_revenue": total_revenue,
        "total_cogs": total_cogs,
        "gross_profit": gross_profit,
        "total_expense": total_expense,
        "net_income": net_income,
        "accrual_ar_adjustment": accrual_adj_rev,
        "accrual_ap_adjustment": accrual_adj_exp,
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "income-statement"),
        "report_label_customized": is_report_label_customized(company, "income-statement"),
    }


# ---------- Balance Sheet ----------

async def compute_balance_sheet(company_id: str, as_of: str, basis: str = "accrual",
                                 imported_only: bool = False):
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    by = await _signed_balances(company_id, start=None, end=as_of,
                                 include_pre_period=True, basis=basis,
                                 imported_only=imported_only)

    # Phase 2 (Feb 28 2026): if `_signed_balances` returned GL-derived
    # balances (see `_has_qbo_gl_data`), every compensating layer
    # below (`_open_ar_ap` bucketing, payments_realized cash roll-in,
    # etc.) would DOUBLE-COUNT because QBO's GL already includes
    # those postings. Skip the layering entirely on the GL path.
    _gl_authoritative = await _has_qbo_gl_data(company_id)

    # ------------------------------------------------------------------
    # A/R and A/P: layer unpaid-invoice / unpaid-bill totals directly
    # onto the corresponding GL account balance BEFORE we emit sections.
    #
    # Historical bug (fixed Feb 27 2026): we used to emit a phantom
    # "Accounts Receivable" / "Accounts Payable" row *after* the section
    # emit, on top of the QBO-imported A/R and A/P accounts. As long as
    # `_signed_balances` was dropping JE lines (see Fix #1 in
    # qbo_service.resolve_journal_entry_line_accounts), the section
    # rows sat empty and the phantom row was the only A/R/A/P we
    # showed — so the numbers looked ok. Once JE lines started posting
    # correctly, every year-end true-up JE to A/R (e.g.
    # "reclassify $85k AR into Note Receivable") appeared TWICE — once
    # in the section row via `by[AR_id]`, and again in the phantom row.
    # BM QBO 2 LLC drifted by $118k on the BS because of this.
    #
    # Fix: bucket `_open_ar_ap` by `ARAccountRef`/`APAccountRef` (QBO
    # tells us which A/R and A/P account each invoice/bill posts to),
    # translate those qbo_ids to local ids, and fold each bucket into
    # `by[local_id]` using the appropriate sign convention. Native (non-
    # QBO) docs with no A/R/A/P ref default to the first A/R and A/P
    # account found in the CoA.
    # ------------------------------------------------------------------
    ar_open = 0.0
    ap_open = 0.0
    ap_split_result: dict | None = None
    if basis == "accrual" and not _gl_authoritative:
        ap_split_result = await _open_ar_ap(company_id, as_of=as_of, start=None)
        ar_open = ap_split_result["ar_end"]
        ap_open = ap_split_result["ap_end"]

        # Local-id lookup keyed on qbo_id AND primary A/R / A/P
        # accounts for the native / no-ref fallback path.
        acct_by_qbo_id = {str(a["qbo_id"]): a for a in accts if a.get("qbo_id")}
        ar_accts = sorted(
            [a for a in accts
             if a["type"] == "asset"
             and (a.get("subtype") or "").lower() == "accountsreceivable"],
            key=lambda a: (a.get("code") or "", a.get("name") or ""),
        )
        ap_accts = sorted(
            [a for a in accts
             if a["type"] == "liability"
             and (a.get("subtype") or "").lower() == "accountspayable"],
            key=lambda a: (a.get("code") or "", a.get("name") or ""),
        )
        primary_ar = ar_accts[0] if ar_accts else None
        primary_ap = ap_accts[0] if ap_accts else None

        for qid, amt in (ap_split_result.get("ar_by_account_qbo_id") or {}).items():
            a = acct_by_qbo_id.get(qid) or primary_ar
            if a and abs(amt) >= 0.005:
                by[a["id"]] = by.get(a["id"], 0.0) + amt
        # Any unbucketed remainder (native invoices w/o ARAccountRef)
        # spills onto the primary A/R.
        bucketed_ar = sum((ap_split_result.get("ar_by_account_qbo_id") or {}).values())
        unbucketed_ar = ar_open - bucketed_ar
        if primary_ar and abs(unbucketed_ar) >= 0.005:
            by[primary_ar["id"]] = by.get(primary_ar["id"], 0.0) + unbucketed_ar

        for qid, amt in (ap_split_result.get("ap_by_account_qbo_id") or {}).items():
            a = acct_by_qbo_id.get(qid) or primary_ap
            # A/P is credit-normal — raw ledger convention stores a
            # positive AP balance as a NEGATIVE `by[]` value (see
            # `_display_amount`). Subtract to reflect an increase.
            if a and abs(amt) >= 0.005:
                by[a["id"]] = by.get(a["id"], 0.0) - amt
        bucketed_ap = sum((ap_split_result.get("ap_by_account_qbo_id") or {}).values())
        unbucketed_ap = ap_open - bucketed_ap
        if primary_ap and abs(unbucketed_ap) >= 0.005:
            by[primary_ap["id"]] = by.get(primary_ap["id"], 0.0) - unbucketed_ap

    # ----- Build parent → children index for hierarchical rollup -----
    # Each account can have `parent_account_id`. Parents (no parent id) show
    # a rolled-up amount = own direct postings + sum of children. Children
    # appear as separate rows with `parent_code` set so consumers can indent
    # or subtotal. The final section totals count only top-level rows so we
    # don't double-count children.
    children_of: dict[str, list[dict]] = {}
    for a in accts:
        pid = a.get("parent_account_id")
        if pid:
            children_of.setdefault(pid, []).append(a)

    _BANK_LIKE_SUBTYPES = {
        "checking", "savings", "moneymarket", "cashonhand",
        "trustaccounts", "moneyinaccount",
        "creditcard",
    }

    def _row(a: dict, direct_amount: float, parent_code: str | None = None,
              parent_id: str | None = None):
        r = {
            "id": a["id"], "code": a["code"], "name": a["name"],
            "amount": round(direct_amount, 2),
            # Carry the Wave-style granular sub-type through so the
            # frontend can group balance-sheet sections into readable
            # sub-headers (Cash and Bank, Property Plant & Equipment,
            # Loan and Line of Credit, etc.).
            "detail_type": (a.get("detail_type") or "").strip(),
            # (Feb 2026 — Phase 1 UK region.) Carry `subtype` too so
            # the UK statutory Balance Sheet renderer can split fixed
            # vs current, and long-term vs short-term creditors. US
            # frontend ignores this field, so the payload stays 100%
            # backward-compatible.
            "subtype": (a.get("subtype") or "").strip(),
        }
        # `parent_code` is optional context for the UI's indentation.
        # `parent_id` (below) is the AUTHORITATIVE child-marker used by
        # the totals loop — some QBO-imported parents have an empty
        # `code`, and using `parent_code` alone caused Original Cost
        # (Truck's child) to lose its is-child flag and get counted a
        # second time toward Total Assets. Feb 26 2026.
        if parent_code:
            r["parent_code"] = parent_code
        if parent_id:
            r["parent_id"] = parent_id
        # Bank/CC-JE-variance annotation. See PRD.md "Known Variance #1
        # — Bank/CC JE Rendering" (Feb 27 2026): QBO's own BS report
        # excludes Journal Entries when computing bank/CC account
        # balances, whereas our engine sums every JE line for GAAP
        # completeness. On QBO-imported companies with year-end
        # adjustment JEs against banks/CCs (e.g. BM QBO 2 LLC's
        # opening-balance JE#7 + Q1-adjustment JE#12), this produces
        # a small documented variance. The UI can look for this flag
        # to render a "matches ledger; may differ from QBO's own BS
        # for accounts with adjustment JEs" tooltip.
        subtype_l = (a.get("subtype") or "").strip().lower()
        if subtype_l in _BANK_LIKE_SUBTYPES and a.get("source") == "qbo":
            r["variance_note"] = "bank_je_rendering"
        return r

    def _emit_section(section_type: str) -> tuple[list[dict], float]:
        """Return (rows, section_total) for one type — assets, liabilities, equity.

        Renders the CoA as a nested tree so grandchildren (e.g. an
        `Allowance` sub-account under `Note Receivable - 72 Holdings`
        under `Client Note Receivables`) roll into their direct parent's
        subtotal, not into the top-level ancestor. Prior single-level
        implementation orphaned every grandchild — a QBO-real pattern
        that put $60k of unmapped activity on BM QBO 2 LLC's BS
        (Feb 27 2026).

        Rendering per subtree (`_walk`):
          * Parent header row → direct amount only (no descendant roll-in)
          * Recursive child rows (with their own subtotals for THEIR
            descendants)
          * `Total {parent}` subtotal row → direct + all descendants
        Suppresses subtrees whose rolled total is ~0.
        """
        def _walk(a: dict, parent_code: str | None,
                  parent_id: str | None) -> tuple[list[dict], float]:
            # QBO parity: soft-deleted accounts whose authoritative
            # `CurrentBalance` is 0 are hidden from QBO's own BS/PL
            # payload (verified on BM QBO 2 LLC's TEMPORARY-BP-Cash,
            # `Active=False` + `CurrentBalance=0`). Our ledger can
            # accumulate residual activity on these (JE lines that
            # debit/credit the account before QBO's hidden closing
            # entry zeroes it out) — those show up as phantom $ on
            # the BS. Skip the whole subtree to match QBO's
            # rendering.  We do NOT skip inactive-with-nonzero
            # accounts: if QBO still carries a balance, we do too.
            # Feb 27 2026 — BM QBO 2 LLC parity fix.
            if a.get("active") is False:
                qcb = float((a.get("raw") or {}).get("CurrentBalance") or 0)
                if abs(qcb) < 0.005:
                    return [], 0.0
            direct = _display_amount(a, by.get(a["id"], 0.0))
            kids_sorted = sorted(
                (k for k in children_of.get(a["id"], [])
                 if k["type"] == section_type),
                key=lambda x: (x.get("code") or "", x.get("name") or ""),
            )
            child_rows: list[dict] = []
            kids_total = 0.0
            for k in kids_sorted:
                k_rows, k_rolled = _walk(k, parent_code=a.get("code") or "",
                                          parent_id=a["id"])
                child_rows.extend(k_rows)
                kids_total += k_rolled
            rolled = direct + kids_total
            keep = abs(rolled) >= 0.005 or a["code"] == "3100"
            if not keep:
                return [], 0.0
            emitted: list[dict] = []
            # Parent header row (direct only). Suppress if this account
            # has neither its own posts nor any visible descendant —
            # avoids empty "container" rows.
            if abs(direct) >= 0.005 or child_rows or a["code"] == "3100":
                emitted.append(_row(a, direct,
                                     parent_code=parent_code,
                                     parent_id=parent_id))
            emitted.extend(child_rows)
            if child_rows:
                sub = _row(a, rolled,
                            parent_code=a.get("code") or "",
                            parent_id=a["id"])
                sub["name"] = f"Total {a['name']}"
                sub["is_subtotal"] = True
                emitted.append(sub)
            return emitted, rolled

        rows: list[dict] = []
        top_total = 0.0
        top_level = [a for a in accts
                     if a["type"] == section_type
                     and not a.get("parent_account_id")]
        # Sort by (detail_type, code) so accounts sharing a Wave-style
        # sub-type end up contiguous — required for the grouped
        # renderer to emit clean sub-type banners in the PDF.
        top_level.sort(
            key=lambda x: ((x.get("detail_type") or "zzz").lower(),
                            (x.get("code") or "")))
        for a in top_level:
            sub_rows, sub_total = _walk(a, parent_code=None, parent_id=None)
            rows.extend(sub_rows)
            top_total += sub_total
        return rows, top_total


    assets, total_assets_raw = _emit_section("asset")
    liabilities, total_liabilities_raw = _emit_section("liability")
    equity, total_equity_raw = _emit_section("equity")

    # Running totals — start from `_emit_section`'s `top_total` (which
    # correctly rolls parent-only + children under it) and layer in
    # any post-emit additions (A/R, A/P, Current Period Net Income).
    # We deliberately DO NOT re-sum the `assets` list at the end: the
    # emit output contains a "Total {parent}" subtotal row per
    # multi-child parent (Truck → Original Cost → Total Truck), and
    # summing those subtotals on top of their children double-counts
    # the value. Also, `sum(only rows with no parent_id/parent_code)`
    # under-counts because the direct-only parent row is $0 while
    # the child carries the $13,495 balance. Feb 28 2026.
    total_assets = total_assets_raw
    total_liabilities = total_liabilities_raw
    total_equity = total_equity_raw

    # Net income roll-in from revenue/expense/COGS accounts. `cogs` is
    # its own account type (Option B GAAP Income Statement, Feb 2026)
    # but still reduces Net Income exactly like a regular expense —
    # otherwise the BS overstates equity by the period's COGS total
    # and the sheet doesn't balance.
    net_income_current = 0.0
    for a in accts:
        if a["type"] in ("revenue", "expense", "cogs"):
            disp = _display_amount(a, by.get(a["id"], 0.0))
            if a["type"] == "revenue":
                net_income_current += disp
            else:
                net_income_current -= disp

    # Accrual basis: A/R (unpaid invoices) and A/P (unpaid bills) are
    # already folded into `by[]` above so the section-emit rows carry
    # the correct combined GL balance. We still need to bump NI by
    # (A/R − A/P) so the sheet balances (invoices/bills represent
    # earned revenue / accrued expense that hasn't yet moved through
    # `_signed_balances`).
    if basis == "accrual":
        # Preserve the top-level `ar_open` / `ap_open` figures returned
        # in the response so callers (Recon Panel, cash-flow bridge)
        # can still read them.
        net_income_current += ar_open - ap_open
        assets.sort(key=lambda x: (x["code"], x.get("parent_code", "")))
        liabilities.sort(key=lambda x: (x.get("parent_code", "") or x["code"], x["code"]))
    elif basis == "cash":
        # Cash-basis convention (matches QBO): Inventory Asset does
        # NOT appear on the cash BS because on cash accounting,
        # inventory is expensed when purchased, not tracked as an
        # asset. Strip it from the asset rows and add its net value
        # to `net_income_current` as an expense adjustment so the
        # sheet still balances (Inventory value on hand effectively
        # rolls into COGS/period expense).
        # Feb 28 2026 — Craig's Landscaping cash BS parity.
        inv_total = 0.0
        kept_assets = []
        for r in assets:
            if (r.get("detail_type") or "").lower() == "inventory":
                inv_total += r["amount"]
                continue
            kept_assets.append(r)
        assets = kept_assets
        if abs(inv_total) >= 0.005:
            total_assets -= inv_total
            net_income_current -= inv_total  # inventory value → cash expense

    # ------------------------------------------------------------------
    # Sales-tax extraction (Feb 28 2026 — Craig's Landscaping BoE parity)
    # ------------------------------------------------------------------
    # Invoices carry `raw.TxnTaxDetail.TaxLine[]`; each line has
    # `TaxRateRef.value` linking to a TaxRate whose TaxAgency owns a
    # payable account. QBO auto-posts each tax line to that agency's
    # payable at invoice time (accrual) or at payment time (cash).
    # Without this pass, sales-tax payables (Board of Equalization,
    # Arizona Dept. of Revenue, etc.) show $0 on our BS and Total
    # Liabilities under-counts by the tax total.
    #
    # Phase 2 (Feb 28 2026): skip on the GL path — QBO's GL already
    # posts sales-tax lines to their payable accounts, so this layer
    # would double-count.
    tax_rate_to_account_id: dict[str, str] = {}
    if not _gl_authoritative:
        tax_rates = await db.tax_rates.find({"company_id": company_id}).to_list(500)
        if tax_rates:
            agency_to_acct: dict[str, str] = {}
            async for a in db.accounts.find({
                "company_id": company_id,
                "raw.AccountSubType": "GlobalTaxPayable",
            }):
                key = (a.get("name") or "").replace(" Payable", "").strip().lower()
                agency_to_acct[key] = a["id"]
            for tr in tax_rates:
                agn = (tr.get("agency_name") or "").strip().lower()
                if not agn:
                    continue
                aid = agency_to_acct.get(agn)
                if aid:
                    tax_rate_to_account_id[str(tr.get("qbo_id"))] = aid

    if tax_rate_to_account_id:
        acct_by_id: dict[str, dict] = {
            a["id"]: a for a in accts if a.get("id")}
        liab_row_by_id = {r["id"]: r
                           for r in liabilities if r.get("id")}
        tax_by_account: dict[str, float] = {}

        async for inv in db.invoices.find({"company_id": company_id,
                                             "source": "qbo"}):
            issue = inv.get("issue_date") or ""
            if not issue or issue > as_of:
                continue
            td = (inv.get("raw") or {}).get("TxnTaxDetail") or {}
            tax_lines = td.get("TaxLine") or []
            if not tax_lines:
                continue
            paid_ratio = 1.0
            if basis == "cash":
                total = float(inv.get("total") or 0)
                if total <= 0.005:
                    continue
                due = float(inv.get("balance_due") or 0)
                paid_ratio = max(0.0, min((total - due) / total, 1.0))
                if paid_ratio < 0.005:
                    continue
            for tl in tax_lines:
                amt = float(tl.get("Amount") or 0) * paid_ratio
                if abs(amt) < 0.005:
                    continue
                rref = (tl.get("TaxLineDetail") or {}).get("TaxRateRef") or {}
                aid = tax_rate_to_account_id.get(str(rref.get("value") or ""))
                if not aid:
                    continue
                tax_by_account[aid] = tax_by_account.get(aid, 0.0) + amt

        # CreditMemo + RefundReceipt tax reversals: subtract their
        # `TxnTaxDetail.TaxLine` amounts from the payable so voided
        # or refunded invoices don't leave phantom tax liability
        # sitting on the BS. Craig's Landscaping had one such CM
        # (BoE $38.50 residual). RefundReceipts on cash basis are
        # fully credited (money already refunded to the customer).
        # Feb 28 2026.
        async for txn in db.transactions.find({
            "company_id": company_id, "source": "qbo",
            "txn_type": {"$in": ["CreditMemo", "RefundReceipt"]},
        }):
            date = txn.get("date") or ""
            if not date or date > as_of:
                continue
            td = (txn.get("raw") or {}).get("TxnTaxDetail") or {}
            tax_lines = td.get("TaxLine") or []
            if not tax_lines:
                continue
            for tl in tax_lines:
                amt = float(tl.get("Amount") or 0)
                if abs(amt) < 0.005:
                    continue
                rref = (tl.get("TaxLineDetail") or {}).get("TaxRateRef") or {}
                aid = tax_rate_to_account_id.get(str(rref.get("value") or ""))
                if not aid:
                    continue
                tax_by_account[aid] = tax_by_account.get(aid, 0.0) - amt

        for aid, tax_amt in tax_by_account.items():
            tax_amt = round(tax_amt, 2)
            if abs(tax_amt) < 0.005:
                continue
            row = liab_row_by_id.get(aid)
            if row:
                row["amount"] = round(row["amount"] + tax_amt, 2)
            else:
                acct = acct_by_id.get(aid)
                if not acct:
                    continue
                liabilities.append({
                    "id": aid, "code": acct.get("code") or "",
                    "name": acct.get("name") or "",
                    "amount": tax_amt,
                    "detail_type": (acct.get("detail_type") or "").strip(),
                })
            total_liabilities += tax_amt
            # Sales-tax collected reduces cash-basis / accrual NI: on
            # accrual the invoice's Gross AR already includes the tax
            # portion, so NI needs a -tax offset to route it out of
            # revenue into the payable. Same on cash for the paid
            # portion — otherwise we'd be double-counting the tax as
            # both revenue and liability.
            net_income_current -= tax_amt

    # ------------------------------------------------------------------
    # Payment cash-side offset. `_signed_balances` now rolls QBO
    # Payments (customer receipts) and BillPayments (vendor payouts)
    # into cash accounts, but their AR/AP-reduction side stays in
    # `invoice.balance_due` / `bill.balance_due` (already reflected via
    # `_open_ar_ap` above). To keep Assets = L + E, mirror the cash
    # movement into NI as a "realized" adjustment: money that shifted
    # from AR to Cash on the asset side needs a matching Revenue-side
    # recognition, since `ar_end` alone under-counts total billed by
    # the collected amount. Same idea for BillPayments in reverse.
    #
    # Phase 2 (Feb 28 2026): on the GL path, QBO's own GL already
    # reflects the AR-to-cash movement (payments show up as -amount
    # on AR and +amount on the deposit account). Skip this layer to
    # avoid double-counting.
    # ------------------------------------------------------------------
    pay_in_total = 0.0
    pay_out_total = 0.0
    if not _gl_authoritative:
        async for _p in db.payments.find({"company_id": company_id,
                                          "date": {"$lte": as_of}}):
            amt = float(_p.get("amount") or 0)
            if amt <= 0.005:
                continue
            # Native payments posted via `posting_service.post_payment_je`
            # now carry BOTH legs (cash + AR/AP) in `journal_entries`.
            # `_signed_balances` folds those in directly, so the AR/AP
            # side no longer stays in `invoice.balance_due` — meaning
            # the historical "realized-revenue" adjustment below would
            # over-recognize NI by the payment amount. Skip posted
            # native payments; QBO payments still need the offset
            # because their AR side lives implicitly in balance_due.
            # Feb 28 2026.
            if _p.get("posted") is True and _p.get("source") != "qbo":
                continue
            if (_p.get("direction") or "in") == "in":
                pay_in_total += amt
            else:
                pay_out_total += amt
        net_income_current += pay_in_total - pay_out_total

    net_income_current = round(net_income_current, 2)
    equity.append({
        "code": "NI", "name": "Current Period Net Income",
        "amount": net_income_current,
    })
    total_equity += net_income_current

    # Round the running totals now that all layers (emit → A/R/A/P →
    # NI) have been folded in. See `total_assets_raw` comment above
    # for why we don't re-sum `assets`/`liabilities`/`equity` here.
    total_assets = round(total_assets, 2)
    total_liabilities = round(total_liabilities, 2)
    total_equity = round(total_equity, 2)
    total_le = round(total_liabilities + total_equity, 2)
    balanced = abs(total_assets - total_le) < 0.02

    return {
        "company_name": company["name"] if company else "", "as_of": as_of, "basis": basis,
        "assets": assets, "liabilities": liabilities, "equity": equity,
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "total_equity": total_equity,
        "total_liabilities_equity": total_le,
        "balanced": balanced,
        "imbalance": round(total_assets - total_le, 2),
        "ar_open": round(ar_open, 2),
        "ap_open": round(ap_open, 2),
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "balance-sheet"),
        "report_label_customized": is_report_label_customized(company, "balance-sheet"),
    }


# ---------- Trial Balance ----------

async def compute_trial_balance(company_id: str, as_of: str):
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    by = await _signed_balances(company_id, start=None, end=as_of, include_pre_period=True)

    rows = []
    total_d = 0.0
    total_c = 0.0
    for a in sorted(accts, key=lambda x: x["code"]):
        raw = by.get(a["id"], 0.0)
        if abs(raw) < 0.005:
            continue
        debit = raw if raw > 0 else 0.0
        credit = -raw if raw < 0 else 0.0
        rows.append({"code": a["code"], "name": a["name"],
                     "debit": round(debit, 2), "credit": round(credit, 2)})
        total_d += debit
        total_c += credit
    return {
        "company_name": company["name"] if company else "", "as_of": as_of,
        "rows": rows, "total_debit": round(total_d, 2), "total_credit": round(total_c, 2),
        "balanced": abs(total_d - total_c) < 0.02,
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "trial-balance"),
    }


# ---------- General Ledger ----------

async def compute_general_ledger(company_id: str, start: str, end: str):
    """List every posting per account with a running balance (signed, debit-normal)."""
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    accts_by_id = {a["id"]: a for a in accts}

    # Opening balances: signed balances as of the day BEFORE start
    from datetime import date as _date
    try:
        d = _date.fromisoformat(start)
        prev_end = (_date(d.year, d.month, d.day).fromordinal(d.toordinal() - 1)).isoformat()
    except Exception:
        prev_end = start
    opening = await _signed_balances(company_id, start=None, end=prev_end, include_pre_period=True)

    # Gather signed postings within [start, end]
    postings: dict[str, list[dict]] = defaultdict(list)

    txns = await db.transactions.find({
        "company_id": company_id, "posted": True,
        "date": {"$gte": start, "$lte": end},
    }).sort("date", 1).to_list(100000)
    for t in txns:
        amt = float(t.get("amount", 0) or 0)
        desc = t.get("description") or t.get("merchant") or ""
        bank = t.get("bank_account_id")
        if bank:
            postings[bank].append({
                "date": t["date"], "description": desc, "signed": amt,
                "source": "Txn", "txn_id": t["id"],
                "ref": f"Txn · {t.get('merchant', '')[:40]}",
            })
        splits = t.get("splits") or []
        if splits:
            split_total = 0.0
            fallback_cat = t.get("category_account_id")
            for s in splits:
                sid = s.get("category_account_id") or s.get("account_id") or fallback_cat
                s_amt = float(s.get("amount", 0) or 0)
                split_total += s_amt
                if sid:
                    postings[sid].append({
                        "date": t["date"], "description": s.get("description") or desc,
                        "signed": -s_amt, "source": "Split", "txn_id": t["id"],
                        "ref": f"Txn split · {t.get('merchant', '')[:30]}",
                    })
            residual = amt - split_total
            aid_cat = t.get("category_account_id")
            if aid_cat and abs(residual) > 0.001:
                postings[aid_cat].append({
                    "date": t["date"], "description": desc, "signed": -residual,
                    "source": "Txn", "txn_id": t["id"],
                    "ref": f"Txn residual · {t.get('merchant', '')[:30]}",
                })
        else:
            aid_cat = t.get("category_account_id")
            if aid_cat:
                postings[aid_cat].append({
                    "date": t["date"], "description": desc, "signed": -amt,
                    "source": "Txn", "txn_id": t["id"],
                    "ref": f"Txn · {t.get('merchant', '')[:40]}",
                })

    jes = await db.journal_entries.find({
        "company_id": company_id, "date": {"$gte": start, "$lte": end},
    }).sort("date", 1).to_list(100000)
    for j in jes:
        memo = j.get("memo") or "Journal Entry"
        for line in j.get("lines", []):
            aid = line.get("account_id")
            if not aid:
                continue
            d = float(line.get("debit", 0) or 0)
            c = float(line.get("credit", 0) or 0)
            postings[aid].append({
                "date": j["date"], "description": line.get("description") or memo,
                "signed": (d - c), "source": "JE", "je_id": j["id"],
                "ref": f"JE · {memo[:40]}",
            })

    sections = []
    for aid, entries in postings.items():
        a = accts_by_id.get(aid)
        if not a:
            continue
        entries.sort(key=lambda x: x["date"])
        credit_normal = a["type"] in CREDIT_NORMAL
        opening_raw = opening.get(aid, 0.0)
        opening_disp = -opening_raw if credit_normal else opening_raw

        rows = []
        run = opening_raw
        for e in entries:
            run += e["signed"]
            disp_delta = -e["signed"] if credit_normal else e["signed"]
            disp_run = -run if credit_normal else run
            rows.append({
                "date": e["date"], "description": e["description"][:80],
                "reference": e["ref"],
                "source": e.get("source", "Txn"),
                "txn_id": e.get("txn_id"),
                "je_id": e.get("je_id"),
                "debit": round(e["signed"], 2) if e["signed"] > 0 else 0.0,
                "credit": round(-e["signed"], 2) if e["signed"] < 0 else 0.0,
                "amount": round(disp_delta, 2),
                "balance": round(disp_run, 2),
            })
        sections.append({
            "code": a["code"], "name": a["name"], "type": a["type"],
            "opening_balance": round(opening_disp, 2),
            "entries": rows,
            "total": rows[-1]["balance"] if rows else round(opening_disp, 2),
        })
    sections.sort(key=lambda s: s["code"] or "")
    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end, "sections": sections,
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "general-ledger"),
    }


# ---------- Cash Flow ----------

async def compute_cash_flow(company_id: str, start: str, end: str):
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    accts_by_id = {a["id"]: a for a in accts}

    txns = await db.transactions.find({
        "company_id": company_id, "posted": True,
        "date": {"$gte": start, "$lte": end},
    }).to_list(100000)

    operating = 0.0
    investing = 0.0
    financing = 0.0
    # Per-account breakdown so the frontend can render drillable
    # sub-rows under each bucket. Keyed by account id (nullable
    # placeholder "__uncat__" for txns without a category).
    buckets: dict = {"operating": {}, "investing": {}, "financing": {}}
    UNCAT_KEY = "__uncat__"
    def _bump(bucket_name, key, name, amt):
        b = buckets[bucket_name]
        row = b.get(key)
        if row is None:
            row = {"id": None if key == UNCAT_KEY else key, "code": "", "name": name, "amount": 0.0}
            b[key] = row
        row["amount"] += amt
    for t in txns:
        amt = float(t.get("amount", 0) or 0)
        aid = t.get("category_account_id")
        a = accts_by_id.get(aid) if aid else None
        if not a:
            operating += amt
            _bump("operating", UNCAT_KEY, "Uncategorized", amt)
            continue
        row_key = a["id"]
        row_name = f"{a.get('code','')} · {a['name']}" if a.get("code") else a["name"]
        if a["type"] in ("revenue", "expense"):
            operating += amt
            _bump("operating", row_key, row_name, amt)
        elif a.get("subtype") == "fixed_asset":
            investing += amt
            _bump("investing", row_key, row_name, amt)
        elif a["type"] == "liability" and "loan" in (a.get("name") or "").lower():
            financing += amt
            _bump("financing", row_key, row_name, amt)
        else:
            operating += amt
            _bump("operating", row_key, row_name, amt)
    net = operating + investing + financing
    def _sort_rows(bucket):
        rows = list(bucket.values())
        for r in rows:
            r["amount"] = round(r["amount"], 2)
            r["code"] = (accts_by_id.get(r["id"]) or {}).get("code", "") if r.get("id") else ""
        rows.sort(key=lambda r: abs(r["amount"]), reverse=True)
        return rows
    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end,
        "operating": round(operating, 2),
        "investing": round(investing, 2),
        "financing": round(financing, 2),
        "net_change": round(net, 2),
        "operating_rows": _sort_rows(buckets["operating"]),
        "investing_rows": _sort_rows(buckets["investing"]),
        "financing_rows": _sort_rows(buckets["financing"]),
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "cash-flow"),
    }


# ---------- Sales Tax Liability ----------

async def compute_sales_tax(company_id: str, start: str, end: str):
    company = await db.companies.find_one({"id": company_id})
    invs = await db.invoices.find({
        "company_id": company_id, "issue_date": {"$gte": start, "$lte": end},
    }).to_list(10000)
    bills = await db.bills.find({
        "company_id": company_id, "issue_date": {"$gte": start, "$lte": end},
    }).to_list(10000)

    collected = sum(float(i.get("tax", 0) or 0) for i in invs)
    paid = sum(float(b.get("tax", 0) or 0) for b in bills)
    taxable_sales = sum(float(i.get("subtotal", 0) or 0) for i in invs if float(i.get("tax", 0) or 0) > 0)
    nontaxable_sales = sum(float(i.get("subtotal", 0) or 0) for i in invs if float(i.get("tax", 0) or 0) == 0)

    settled_tax = 0.0
    for i in invs:
        total = float(i.get("total", 0) or 0)
        bal = float(i.get("balance_due", total) or 0)
        if total > 0:
            paid_ratio = max(0.0, min(1.0, (total - bal) / total))
            settled_tax += float(i.get("tax", 0) or 0) * paid_ratio

    net_liability = collected - paid
    rows = [
        {"label": "Taxable sales", "amount": round(taxable_sales, 2)},
        {"label": "Non-taxable sales", "amount": round(nontaxable_sales, 2)},
        {"label": "Sales tax collected (invoiced)", "amount": round(collected, 2)},
        {"label": "Sales tax collected & received", "amount": round(settled_tax, 2)},
        {"label": "Sales tax paid on purchases", "amount": round(paid, 2)},
    ]
    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end,
        "rows": rows,
        "net_liability": round(net_liability, 2),
        "invoices_count": len(invs),
        "bills_count": len(bills),
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "sales-tax"),
    }


# ---------- 1099 Summary ----------

async def compute_1099_summary(company_id: str, year: int):
    company = await db.companies.find_one({"id": company_id})
    start = f"{year}-01-01"; end = f"{year}-12-31"
    contacts = await db.contacts.find({"company_id": company_id, "type": {"$in": ["vendor", "both"]}}).to_list(2000)
    contact_by_id = {c["id"]: c for c in contacts}
    contact_by_name = {(c.get("name") or "").lower(): c for c in contacts}

    totals = {c["id"]: 0.0 for c in contacts}
    bills = await db.bills.find({
        "company_id": company_id, "issue_date": {"$gte": start, "$lte": end},
    }).to_list(20000)
    for b in bills:
        cid = b.get("contact_id")
        if not cid or cid not in totals:
            continue
        total = float(b.get("total", 0) or 0)
        bal = float(b.get("balance_due", total) or 0)
        paid_amt = max(0.0, total - bal)
        totals[cid] += paid_amt

    txns = await db.transactions.find({
        "company_id": company_id, "posted": True,
        "date": {"$gte": start, "$lte": end}, "amount": {"$lt": 0},
    }).to_list(50000)
    for t in txns:
        merch = (t.get("merchant") or "").lower()
        c = contact_by_name.get(merch)
        if not c:
            continue
        totals[c["id"]] += abs(float(t.get("amount", 0) or 0))

    rows = []
    for cid_, amt in totals.items():
        if amt < 600.0:
            continue
        c = contact_by_id[cid_]
        rows.append({
            "contact_id": cid_,
            "contact_name": c.get("name"),
            "contact_email": c.get("email", ""),
            "tin": c.get("tin", ""),
            "w9_on_file": bool(c.get("w9_on_file", False)),
            "total_paid": round(amt, 2),
        })
    rows.sort(key=lambda r: r["total_paid"], reverse=True)
    return {
        "company_name": company["name"] if company else "",
        "year": year,
        "rows": rows,
        "total_reportable": round(sum(r["total_paid"] for r in rows), 2),
        "count": len(rows),
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "1099-summary"),
    }


# ---------- A/R Aging ----------

async def compute_ar_aging(company_id: str, as_of: str):
    return await _aging(company_id, as_of, kind="ar")


async def compute_ap_aging(company_id: str, as_of: str):
    return await _aging(company_id, as_of, kind="ap")


async def _aging(company_id: str, as_of: str, kind: str):
    """Bucket outstanding A/R (invoices) or A/P (bills) by days past due."""
    from datetime import date as _date
    company = await db.companies.find_one({"id": company_id})
    coll = "invoices" if kind == "ar" else "bills"
    docs = await db[coll].find({"company_id": company_id}).to_list(10000)
    buckets = {"current": 0.0, "1_30": 0.0, "31_60": 0.0, "61_90": 0.0, "over_90": 0.0}
    lines = []
    try:
        today = _date.fromisoformat(as_of)
    except Exception:
        today = _date.today()
    for i in docs:
        if i.get("status") == "paid":
            continue
        bal = float(i.get("balance_due", 0) or 0)
        if bal <= 0.005:
            continue
        due_str = i.get("due_date") or ""
        try:
            due = _date.fromisoformat(due_str)
            days_past = (today - due).days
        except Exception:
            days_past = 0
        if days_past <= 0:
            bucket = "current"
        elif days_past <= 30:
            bucket = "1_30"
        elif days_past <= 60:
            bucket = "31_60"
        elif days_past <= 90:
            bucket = "61_90"
        else:
            bucket = "over_90"
        buckets[bucket] += bal
        lines.append({
            "id": i["id"], "number": i.get("number"),
            "contact_name": i.get("contact_name") or "",
            "issue_date": i.get("issue_date"), "due_date": due_str,
            "balance_due": round(bal, 2),
            "days_past_due": days_past, "bucket": bucket,
        })
    lines.sort(key=lambda x: (-x["days_past_due"], x["contact_name"] or ""))
    total = round(sum(buckets.values()), 2)
    return {
        "company_name": company["name"] if company else "",
        "as_of": as_of,
        "buckets": {k: round(v, 2) for k, v in buckets.items()},
        "lines": lines,
        "total": total,
    }


# ---------- PDF rendering helpers ----------

def _pdf_styles(rs: dict | None = None):
    """ReportLab paragraph styles resolved against a per-company
    `report_style` dict (see `resolve_report_style`). Falls back to sane
    Helvetica defaults when nothing is stored yet. Supports built-in
    RL families (Helvetica / Times-Roman / Courier) plus the 12 bundled
    TTFs — see `AVAILABLE_FONTS`. If a stored family isn't available
    (missing TTF, corrupted file, etc.) we silently degrade to
    Helvetica so a broken font doesn't crash the PDF pipeline."""
    rs = rs or resolve_report_style(None)
    fam = rs.get("font_family") or "Helvetica"
    # Built-in ReportLab families use RL's naming convention for Bold.
    builtin_bold_map = {
        "Helvetica":   "Helvetica-Bold",
        "Times-Roman": "Times-Bold",
        "Courier":     "Courier-Bold",
    }
    if fam in builtin_bold_map:
        fam_bold = builtin_bold_map[fam]
    elif fam in AVAILABLE_FONTS:
        fam_bold = f"{fam}-Bold"
    else:
        # Unknown family — fall back to Helvetica so we never crash.
        log.warning("Requested report font %r not registered; falling back to Helvetica", fam)
        fam = "Helvetica"
        fam_bold = "Helvetica-Bold"
    styles = getSampleStyleSheet()
    title_size = float(rs.get("title_font_size") or 18)
    sub_size = float(rs.get("subtitle_font_size") or 11)
    sec_size = float(rs.get("section_font_size") or 11)
    # `leading` sets the paragraph's line box height. Without it,
    # ReportLab uses ~1.2× font size but stacks paragraphs so tightly
    # that an 18pt title's descender overlaps the next 11pt line. Force
    # an explicit leading + spaceAfter to guarantee breathing room.
    styles.add(ParagraphStyle(
        name="Title2", fontName=fam_bold, fontSize=title_size,
        leading=title_size * 1.25,
        alignment=1,
        textColor=colors.HexColor(rs.get("title_color") or "#0F172A"),
        spaceAfter=float(rs.get("title_space_after") or 10),
    ))
    styles.add(ParagraphStyle(
        name="SubTitle", fontName=fam, fontSize=sub_size,
        leading=sub_size * 1.4,
        alignment=1,
        textColor=colors.HexColor(rs.get("subtitle_color") or "#52525B"),
        spaceAfter=float(rs.get("subtitle_space_after") or 3),
    ))
    styles.add(ParagraphStyle(
        name="Section", fontName=fam_bold, fontSize=sec_size,
        leading=sec_size * 1.3,
        textColor=colors.HexColor(rs.get("section_color") or "#0F172A"),
        backColor=colors.HexColor(rs.get("section_bg_color") or "#F1F5F9"),
        spaceBefore=8, spaceAfter=4, leftIndent=4, rightIndent=4,
    ))
    return styles


# ────────────────────────────────────────────────────────────────
# Report styling — per-company overrides for label/font/color/spacing
# ────────────────────────────────────────────────────────────────

# Default report display labels. Keys line up with the URL slugs used by
# `ReportView.jsx` (see the `title` map in that file) so a single
# label-override dictionary drives both the on-screen heading and the
# PDF title.
DEFAULT_REPORT_LABELS = {
    "income-statement":   "Income Statement",
    "balance-sheet":      "Balance Sheet",
    "trial-balance":      "Trial Balance",
    "general-ledger":     "General Ledger",
    "cash-flow":          "Statement of Cash Flows",
    "sales-tax":          "Sales Tax Liability",
    "1099-summary":       "1099 Summary",
    "account-detail":     "Account Detail",
}

# The full defaults applied when a company hasn't customized report
# styling yet (or has customized only a few fields). Keep every knob the
# UI exposes here so front-end and PDF stay in lock-step.
DEFAULT_REPORT_STYLE = {
    "font_family":           "Helvetica",       # Helvetica | Times-Roman | Courier
    "title_font_size":       18,
    "title_color":           "#0F172A",
    "title_space_after":     10,                # pt below the company-name title
    "subtitle_font_size":    11,
    "subtitle_color":        "#52525B",
    "subtitle_space_after":  3,
    "section_font_size":     11,
    "section_color":         "#0F172A",
    "section_bg_color":      "#F1F5F9",
    "labels":                {},                # per-report overrides, see DEFAULT_REPORT_LABELS
}


def resolve_report_style(company: dict | None) -> dict:
    """Merge stored `report_style` overrides onto the app defaults.

    Missing / null / empty-string values fall through to the default so
    the CPA can clear a single field on the settings page without
    zeroing the whole record."""
    stored = ((company or {}).get("report_style")) or {}
    out = dict(DEFAULT_REPORT_STYLE)
    for k, v in stored.items():
        if k == "labels":
            continue
        if v is None or v == "":
            continue
        out[k] = v
    # Labels merge separately — start from defaults, layer overrides.
    labels = dict(DEFAULT_REPORT_LABELS)
    for k, v in (stored.get("labels") or {}).items():
        if v:
            labels[k] = v
    out["labels"] = labels
    return out


def resolve_report_label(company: dict | None, kind: str) -> str:
    """Return the user-facing label for a given report kind."""
    rs = resolve_report_style(company)
    return rs["labels"].get(kind) or DEFAULT_REPORT_LABELS.get(kind, kind)


def is_report_label_customized(company: dict | None, kind: str) -> bool:
    """True iff the customer explicitly renamed this report via Company
    Settings. Used by the frontend to decide whether to honour the
    backend `report_label` (customer choice) or apply a region-aware
    default like "Statement of Financial Position" for UK companies."""
    rs = resolve_report_style(company)
    label = rs["labels"].get(kind)
    return bool(label) and label != DEFAULT_REPORT_LABELS.get(kind)


def _money_table(rows, totals_label, totals_amount):
    data = [[r.get("code", ""), r["name"], f"${r['amount']:,.2f}"] for r in rows]
    data.append(["", totals_label, f"${totals_amount:,.2f}"])
    t = Table(data, colWidths=[0.9 * inch, 4.2 * inch, 1.4 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("ALIGN", (2, 0), (2, -1), "RIGHT"),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#52525B")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]))
    return t


# ── Balance-sheet-specific renderer: injects Wave-style sub-type
# banner rows (Cash and Bank, Property Plant & Equipment, Loan and
# Line of Credit, etc.) before each contiguous run of accounts that
# share a `detail_type`. Falls back to the flat `_money_table` look
# when nothing in the section carries a detail_type.
_DETAIL_PDF_LABELS = {
    "cash_and_bank": "Cash and Bank",
    "money_in_transit": "Money in Transit",
    "expected_payments_from_customers": "Accounts Receivable",
    "inventory": "Inventory",
    "property_plant_equipment": "Property, Plant & Equipment",
    "depreciation_and_amortization": "Depreciation and Amortization",
    "vendor_prepayments": "Vendor Prepayments & Credits",
    "other_short_term_asset": "Other Short-Term Asset",
    "other_long_term_asset": "Other Long-Term Asset",
    "credit_card": "Credit Card",
    "loan_and_line_of_credit": "Loan and Line of Credit",
    "expected_payments_to_vendors": "Accounts Payable",
    "due_for_payroll": "Due For Payroll",
    "due_to_owners": "Due to Owners",
    "customer_prepayments": "Customer Prepayments & Credits",
    "sales_tax_payable": "Sales Tax Payable",
    "other_short_term_liability": "Other Short-Term Liability",
    "other_long_term_liability": "Other Long-Term Liability",
    "owner_contribution_drawing": "Owner Contribution & Drawing",
    "retained_earnings": "Retained Earnings",
    "other_equity": "Other Equity",
}


def _money_table_grouped(rows, totals_label, totals_amount):
    has_any_detail = any(r.get("detail_type") for r in rows)
    if not has_any_detail:
        return _money_table(rows, totals_label, totals_amount)

    data: list[list] = []
    banner_indices: list[int] = []  # row indices where a banner sits
    current_detail = "___INIT___"
    for r in rows:
        dt = (r.get("detail_type") or "").strip()
        if dt != current_detail:
            current_detail = dt
            if dt:
                data.append(["", _DETAIL_PDF_LABELS.get(dt, dt.replace("_", " ").title()), ""])
                banner_indices.append(len(data) - 1)
        data.append([r.get("code", ""), r["name"], f"${r['amount']:,.2f}"])
    data.append(["", totals_label, f"${totals_amount:,.2f}"])

    t = Table(data, colWidths=[0.9 * inch, 4.2 * inch, 1.4 * inch])
    style_cmds = [
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("ALIGN", (2, 0), (2, -1), "RIGHT"),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#52525B")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]
    for i in banner_indices:
        style_cmds.extend([
            ("FONTNAME", (0, i), (-1, i), "Helvetica-Bold"),
            ("FONTSIZE", (0, i), (-1, i), 7.5),
            ("TEXTCOLOR", (0, i), (-1, i), colors.HexColor("#64748B")),
            ("BACKGROUND", (0, i), (-1, i), colors.HexColor("#F8FAFC")),
            ("TOPPADDING", (0, i), (-1, i), 6),
            ("BOTTOMPADDING", (0, i), (-1, i), 3),
        ])
    t.setStyle(TableStyle(style_cmds))
    return t


def build_income_statement_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "Income Statement").upper()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(label, s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']} &middot; {data['basis'].title()} Basis", s["SubTitle"]),
        Spacer(1, 12),
        Paragraph("REVENUE", s["Section"]),
        _money_table_grouped(data["revenue"], "Total Income", data["total_revenue"]),
        Spacer(1, 8),
    ]
    # COGS + Gross Profit only render when there's activity in the
    # cogs bucket. Companies without cost of sales (service, SaaS,
    # condo assocs) keep a clean two-section P&L; inventory / restaurant
    # / retail businesses get a proper GAAP-style Gross Profit line.
    cogs_rows = data.get("cogs") or []
    total_cogs = data.get("total_cogs") or 0
    if cogs_rows or abs(total_cogs) >= 0.005:
        story += [
            Paragraph("COST OF GOODS SOLD", s["Section"]),
            _money_table_grouped(cogs_rows, "Total Cost of Goods Sold", total_cogs),
            Spacer(1, 8),
            _money_table([], "GROSS PROFIT", data.get("gross_profit") or 0),
            Spacer(1, 12),
        ]
    story += [
        Paragraph("OPERATING EXPENSES", s["Section"]),
        _money_table_grouped(data["expenses"], "Total Expenses", data["total_expense"]),
        Spacer(1, 12),
        _money_table([], "NET INCOME", data["net_income"]),
    ]
    doc.build(story)
    return buf.getvalue()


def build_balance_sheet_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "Balance Sheet").upper()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(label, s["SubTitle"]),
        Paragraph(f"As of {data['as_of']} &middot; {data['basis'].title()} Basis", s["SubTitle"]),
        Spacer(1, 12),
        Paragraph("ASSETS", s["Section"]),
        _money_table_grouped(data["assets"], "Total Assets", data["total_assets"]),
        Spacer(1, 8),
        Paragraph("LIABILITIES", s["Section"]),
        _money_table_grouped(data["liabilities"], "Total Liabilities", data["total_liabilities"]),
        Spacer(1, 8),
        Paragraph("EQUITY", s["Section"]),
        _money_table_grouped(data["equity"], "Total Equity", data["total_equity"]),
        Spacer(1, 12),
        _money_table([], "TOTAL LIABILITIES & EQUITY", data["total_liabilities_equity"]),
    ]
    if not data.get("balanced", True):
        story.append(Spacer(1, 10))
        story.append(Paragraph(
            f"⚠ Imbalance detected: ${data['imbalance']:,.2f}", s["SubTitle"],
        ))
    doc.build(story)
    return buf.getvalue()


def build_trial_balance_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "Trial Balance").upper()
    rows = [["Code", "Account", "Debit", "Credit"]]
    for r in data["rows"]:
        rows.append([r["code"], r["name"], f"${r['debit']:,.2f}" if r["debit"] else "",
                     f"${r['credit']:,.2f}" if r["credit"] else ""])
    rows.append(["", "TOTAL", f"${data['total_debit']:,.2f}", f"${data['total_credit']:,.2f}"])
    t = Table(rows, colWidths=[0.9 * inch, 3.6 * inch, 1.2 * inch, 1.2 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]))
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(label, s["SubTitle"]),
        Paragraph(f"As of {data['as_of']}", s["SubTitle"]),
        Spacer(1, 12), t,
    ]
    doc.build(story)
    return buf.getvalue()


def build_general_ledger_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "General Ledger").upper()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(label, s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']}", s["SubTitle"]),
        Spacer(1, 10),
    ]
    for sec in data["sections"]:
        story.append(Paragraph(f"{sec['code']} — {sec['name']}", s["Section"]))
        rows = [["Date", "Source", "Description", "Debit", "Credit", "Balance"]]
        rows.append(["", "", f"Opening balance", "", "", f"${sec['opening_balance']:,.2f}"])
        for e in sec["entries"]:
            rows.append([e["date"], e.get("source", "Txn"), e["description"][:45],
                         f"${e['debit']:,.2f}" if e["debit"] else "",
                         f"${e['credit']:,.2f}" if e["credit"] else "",
                         f"${e['balance']:,.2f}"])
        rows.append(["", "", "Ending Balance", "", "", f"${sec['total']:,.2f}"])
        t = Table(rows, colWidths=[0.75 * inch, 0.55 * inch, 2.6 * inch, 0.9 * inch, 0.9 * inch, 1.0 * inch])
        t.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("ALIGN", (3, 0), (-1, -1), "RIGHT"),
        ]))
        story.append(t)
        story.append(Spacer(1, 8))
    doc.build(story)
    return buf.getvalue()


def build_cash_flow_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "Statement of Cash Flows").upper()
    rows = [
        ["Cash flow from Operating Activities", f"${data['operating']:,.2f}"],
        ["Cash flow from Investing Activities", f"${data['investing']:,.2f}"],
        ["Cash flow from Financing Activities", f"${data['financing']:,.2f}"],
        ["Net Change in Cash", f"${data['net_change']:,.2f}"],
    ]
    t = Table(rows, colWidths=[4.5 * inch, 2 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(label, s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']}", s["SubTitle"]),
        Spacer(1, 14), t,
    ]
    doc.build(story)
    return buf.getvalue()


def build_sales_tax_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "Sales Tax Liability").upper()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(label, s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']}", s["SubTitle"]),
        Spacer(1, 12),
    ]
    rows = [[r["label"], f"${r['amount']:,.2f}"] for r in data["rows"]]
    rows.append(["Net sales tax liability owed", f"${data['net_liability']:,.2f}"])
    t = Table(rows, colWidths=[4.5 * inch, 2 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(t)
    doc.build(story)
    return buf.getvalue()


def build_1099_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "1099 Summary").upper()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(label, s["SubTitle"]),
        Paragraph(f"Tax year {data['year']} · Contractors paid ≥ $600", s["SubTitle"]),
        Spacer(1, 12),
    ]
    rows = [["Contractor", "TIN / EIN", "W-9 on file", "Total Paid"]]
    for r in data["rows"]:
        rows.append([r["contact_name"], r["tin"] or "—",
                     "Yes" if r["w9_on_file"] else "No", f"${r['total_paid']:,.2f}"])
    rows.append(["", "", "TOTAL", f"${data['total_reportable']:,.2f}"])
    t = Table(rows, colWidths=[3.0 * inch, 1.5 * inch, 1.0 * inch, 1.4 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (3, 0), (3, -1), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t)
    if not data["rows"]:
        story.append(Spacer(1, 20))
        story.append(Paragraph("No contractors met the $600 reporting threshold this year.",
                               s["SubTitle"]))
    doc.build(story)
    return buf.getvalue()


# =========================================================================
#                        Account Detail (transaction report)
# =========================================================================
# A per-account transaction listing (used when the user drills into a
# balance-sheet row). Same visual grammar as trial balance / general ledger
# so it fits naturally alongside the other reports.

async def compute_account_detail(company_id: str, account_id: str,
                                 start: str | None = None, end: str | None = None,
                                 q: str | None = None,
                                 contact_id: str | None = None,
                                 min_amount: float | None = None,
                                 max_amount: float | None = None):
    company = await db.companies.find_one({"id": company_id})
    # Support both single-account drill (from CoA row click) and
    # sub-type drill (from Balance Sheet banner click). When multiple
    # comma-separated account IDs come in, we aggregate transactions
    # across all of them so pros can eyeball an entire sub-type (e.g.
    # every Cash and Bank movement) in one view.
    account_ids = [x for x in (account_id or "").split(",") if x.strip()]
    if not account_ids:
        return {
            "company_name": company["name"] if company else "",
            "account": None, "rows": [], "count": 0, "sum_amount": 0.0, "balance": 0.0,
            "report_style": resolve_report_style(company),
            "report_label": resolve_report_label(company, "account-detail"),
        }
    account_docs = await db.accounts.find(
        {"id": {"$in": account_ids}, "company_id": company_id}
    ).to_list(500)
    if not account_docs:
        return {
            "company_name": company["name"] if company else "",
            "account": None, "rows": [], "count": 0, "sum_amount": 0.0, "balance": 0.0,
            "report_style": resolve_report_style(company),
            "report_label": resolve_report_label(company, "account-detail"),
        }
    is_multi = len(account_docs) > 1
    # Present the aggregated account as a synthetic "account" so the
    # frontend header shows something meaningful ("Cash and Bank · 3
    # accounts" rather than a single row's name).
    if is_multi:
        agg_name = f"{len(account_docs)} accounts · " + ", ".join(a.get("name", "") for a in account_docs[:3])
        if len(account_docs) > 3:
            agg_name += f" +{len(account_docs) - 3} more"
        account = {"id": ",".join(a["id"] for a in account_docs), "name": agg_name, "code": "", "type": account_docs[0].get("type")}
    else:
        account = account_docs[0]

    # -------- Expand parent → descendant sub-accounts --------
    # The Balance Sheet rolls a parent row up to include every child's
    # movements, so a click on that row must drill into the SAME set of
    # transactions to match. If we only queried the parent's own id we'd
    # miss any txn that posted to a sub-account (e.g. "Business Checking"
    # parent with a "Business Checking - ATM Card" child) and the drill
    # would show 0 txns / $0 while the BS clearly shows a non-zero
    # balance. Walk the tree here so parent clicks pull descendants,
    # while sub-account clicks stay scoped to their own id.
    acct_id_list = [a["id"] for a in account_docs]
    _seen = set(acct_id_list)
    _frontier = list(acct_id_list)
    while _frontier:
        kids = await db.accounts.find(
            {"company_id": company_id, "parent_account_id": {"$in": _frontier}},
            {"id": 1},
        ).to_list(500)
        _frontier = [k["id"] for k in kids if k["id"] not in _seen]
        for kid_id in _frontier:
            _seen.add(kid_id)
            acct_id_list.append(kid_id)

    # The Account Detail page has two personalities depending on what you
    # click on the Balance Sheet or Income Statement:
    #
    #   • Bank / Cash / Credit-Card row  → you want to see MOVEMENTS through
    #     that account (deposits + withdrawals). Those rows carry the account
    #     in `bank_account_id` (Plaid/manual imports) or `account_id` (legacy).
    #
    #   • Expense / Revenue / Liability payment row → you want to see
    #     transactions categorised AS that account. Those rows carry it in
    #     `category_account_id` (or inside `splits[].category_account_id`).
    #
    # Previously the query only matched `category_account_id` + `account_id`,
    # so any bank/asset account whose transactions posted via `bank_account_id`
    # (the standard field used by `_signed_balances` for the BS balance) came
    # back empty even though the Balance Sheet clearly showed a non-zero
    # balance. Now we match on all three fields plus the splits array so
    # every account type drills correctly. Duplicate hits (a transaction that
    # references the same account on both sides — e.g. an internal transfer)
    # collapse naturally because Mongo returns each doc once.
    # `acct_id_list` above already includes descendant sub-account ids
    # (walked up top so parent clicks pull child postings too).
    # Match `_signed_balances`: only count `posted=True` transactions so the
    # drill-down running balance ties to the Balance Sheet / Income Statement
    # figure the user clicked on. Unposted (needs-review) rows are excluded
    # because they aren't in the BS balance either.
    mongo_q: dict = {
        "company_id": company_id,
        "posted": True,
        "$or": [
            {"category_account_id": {"$in": acct_id_list}},
            {"account_id": {"$in": acct_id_list}},
            {"bank_account_id": {"$in": acct_id_list}},
            {"splits.category_account_id": {"$in": acct_id_list}},
            {"splits.account_id": {"$in": acct_id_list}},
        ],
    }
    if start:
        mongo_q.setdefault("date", {})["$gte"] = start
    if end:
        mongo_q.setdefault("date", {})["$lte"] = end
    if contact_id:
        mongo_q["contact_id"] = contact_id

    txns = await db.transactions.find(mongo_q).sort([("date", 1), ("_id", 1)]).to_list(5000)

    # Post-filter for free-text search (merchant / description / contact_name)
    # and amount range. Kept in Python to keep index usage tight and to support
    # case-insensitive matching without regex escaping surprises.
    needle = (q or "").strip().lower()

    def _match(t: dict) -> bool:
        if needle:
            hay = " ".join([
                str(t.get("merchant") or ""),
                str(t.get("description") or ""),
                str(t.get("contact_name") or ""),
            ]).lower()
            if needle not in hay:
                return False
        amt = float(t.get("amount") or 0.0)
        if min_amount is not None and abs(amt) < float(min_amount) - 0.001:
            return False
        if max_amount is not None and abs(amt) > float(max_amount) + 0.001:
            return False
        return True

    filtered = [t for t in txns if _match(t)]

    acct_id_set = set(acct_id_list)

    # Also pull JE lines that hit this account — `_signed_balances` includes
    # them in the Balance Sheet figure, so the drill-down needs to as well
    # (opening balances, transfers, manual/adjusting JEs, GL import, etc.).
    je_q: dict = {"company_id": company_id, "lines.account_id": {"$in": acct_id_list}}
    je_date_filter: dict = {}
    if start:
        je_date_filter["$gte"] = start
    if end:
        je_date_filter["$lte"] = end
    if je_date_filter:
        je_q["date"] = je_date_filter
    jes = await db.journal_entries.find(je_q).to_list(5000)

    je_rows: list[dict] = []
    for j in jes:
        for line in j.get("lines", []):
            if line.get("account_id") not in acct_id_set:
                continue
            d = float(line.get("debit", 0) or 0)
            c = float(line.get("credit", 0) or 0)
            memo = line.get("description") or line.get("memo") or j.get("memo") or j.get("reference") or "Journal Entry"
            if needle and needle not in memo.lower():
                continue
            amt = d - c  # signed raw ledger amount (debit +, credit -)
            if min_amount is not None and abs(amt) < float(min_amount) - 0.001:
                continue
            if max_amount is not None and abs(amt) > float(max_amount) + 0.001:
                continue
            je_rows.append({
                "id": j.get("id"),
                "je_id": j.get("id"),
                "date": j.get("date"),
                "merchant": memo,
                "description": memo,
                "contact_name": "",
                "amount": round(amt, 2),
                # Raw delta already carries the right sign for the ledger; same
                # convention as `_signed_balances` (debit +, credit −).
                "_je_delta": amt,
                "source": "JE",
            })

    # Delta convention:
    #   • For a bank/asset account row → the account is on the `bank_account_id`
    #     side, so the movement equals the transaction amount directly
    #     (deposit +$100 raises the balance by $100).
    #   • For a category row (expense/revenue/liability/equity) → the account
    #     is on the `category_account_id` (or `splits[]`) side, so the
    #     movement is `-amount` (an expense transaction of -$100 raises the
    #     expense balance by $100).
    #   • For split lines that reference the account, use the split's own
    #     amount with the same sign flip.

    def _row_delta(t: dict) -> float:
        amt = float(t.get("amount") or 0.0)
        # Bank-side match?
        if (t.get("bank_account_id") in acct_id_set) or (t.get("account_id") in acct_id_set):
            return amt
        # Split-line match?
        for s in (t.get("splits") or []):
            sid = s.get("category_account_id") or s.get("account_id")
            if sid in acct_id_set:
                return -float(s.get("amount") or 0.0)
        # Category-side match (default).
        return -amt

    # Merge txn rows + JE rows, sort oldest → newest so the running balance
    # accumulates in ledger order.
    all_rows: list[dict] = []
    for t in filtered:
        delta = _row_delta(t)
        all_rows.append({
            "id": t.get("id"),
            "date": t.get("date"),
            "merchant": t.get("merchant") or t.get("contact_name") or t.get("description"),
            "description": t.get("description"),
            "contact_name": t.get("contact_name") or "",
            "amount": round(t.get("amount") or 0.0, 2),
            "_delta": delta,
            "needs_review": bool(t.get("needs_review")),
            "source": "Txn",
        })
    for jr in je_rows:
        all_rows.append({
            "id": jr["id"],
            "je_id": jr["je_id"],
            "date": jr["date"],
            "merchant": jr["merchant"],
            "description": jr["description"],
            "contact_name": jr["contact_name"],
            "amount": jr["amount"],
            "_delta": jr["_je_delta"],
            "needs_review": False,
            "source": "JE",
        })
    all_rows.sort(key=lambda r: (r.get("date") or "", r.get("id") or ""))

    running = 0.0
    rows: list[dict] = []
    for r in all_rows:
        delta = float(r.pop("_delta"))
        running += delta
        r["delta"] = round(delta, 2)
        r["running"] = round(running, 2)
        rows.append(r)
    # Newest → oldest for display.
    rows.reverse()

    return {
        "company_name": company["name"] if company else "",
        "account": {
            "id": account["id"], "code": account["code"], "name": account["name"],
            "type": account["type"], "parent_account_id": account.get("parent_account_id"),
        },
        "rows": rows,
        "count": len(rows),
        "sum_amount": round(sum(r.get("amount") or 0.0 for r in rows), 2),
        "balance": round(running, 2),
        "period_start": start,
        "period_end": end,
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "account-detail"),
    }


def build_account_detail_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    a = data["account"] or {}
    label = (data.get("report_label") or "Account Detail").upper()
    subtitle = f"{label} &middot; {a.get('code', '')} {a.get('name', '')}"
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(subtitle, s["SubTitle"]),
        Paragraph(
            f"{data['count']} transaction{'' if data['count'] == 1 else 's'} "
            f"&middot; running balance ${data['balance']:,.2f}",
            s["SubTitle"],
        ),
        Spacer(1, 12),
    ]
    rows = [["Date", "Merchant / Description", "Amount", "Running Balance"]]
    for r in data["rows"]:
        rows.append([
            r.get("date") or "",
            (r.get("merchant") or r.get("description") or "")[:60],
            f"${r['amount']:,.2f}",
            f"${r['running']:,.2f}",
        ])
    rows.append(["", "TOTAL", f"${data['sum_amount']:,.2f}", f"${data['balance']:,.2f}"])
    t = Table(rows, colWidths=[1.0 * inch, 3.7 * inch, 1.1 * inch, 1.4 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(t)
    if not data["rows"]:
        story.append(Spacer(1, 20))
        story.append(Paragraph("No transactions have posted to this account.", s["SubTitle"]))
    doc.build(story)
    return buf.getvalue()
