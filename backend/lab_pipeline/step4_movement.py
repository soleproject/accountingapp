"""Step 4 — match money movements before contact/category work.

Deterministic, no LLM. Fills these outcomes on each ``lab_transactions``
row when applicable:

  * ``movement_type = "internal_transfer"``   — equal amount, opposite
                                                 direction, different
                                                 connected accounts,
                                                 within ±3 days.
  * ``movement_type = "card_payment"``        — bank outflow matched to
                                                 credit-card inflow.
  * ``movement_type = "outside_transfer"``    — transfer to an outside
                                                 bank account we
                                                 registered in step 3.
  * ``movement_type = "payment_app_transfer"``— transfer into or out of
                                                 a payment app account.
  * ``movement_type = "credit_line_payment"`` — payment to a credit
                                                 line detected in step
                                                 3 (e.g., PayPal Credit
                                                 CREDIT REPAYMEN).
  * ``movement_type = "unpaired_transfer"``   — transfer-language row
                                                 with no matching leg;
                                                 goes to stage 1.
  * ``movement_confidence``                   — "high" | "low"; low
                                                 fires for equal-amount
                                                 opposite-direction
                                                 pairs where NEITHER leg
                                                 carries transfer
                                                 language OR matching
                                                 last-4.
  * ``movement_pair_id``                      — shared uuid across both
                                                 legs of a matched
                                                 movement.

Matched rows short-circuit later steps (contact / category are ignored
by the downstream reader when ``movement_type`` is populated).
"""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timedelta
from db import db
from .collections import LAB_TRANSACTIONS
from .step2_parse import (
    has_transfer_language, extract_dest_last4, classify_channel,
    parse_bank_desc,
)

log = logging.getLogger("axiom.lab.step4")


def _parse_date(s):
    if isinstance(s, datetime):
        return s
    try:
        return datetime.fromisoformat(str(s)[:10])
    except Exception:
        return None


def _abs_amt(t):
    return abs(float(t.get("amount") or 0))


def _direction_from_amount(a):
    return "out" if float(a or 0) > 0 else "in"


class MovementMatcher:
    """One instance per company per run. Bounded, deterministic."""

    def __init__(self, *, company_id: str,
                 connected_accounts: list[dict],
                 lab_company_accounts: dict[str, dict],
                 settings: dict) -> None:
        self.cid = company_id
        self.connected = {a["account_id"]: a for a in connected_accounts}
        self.connected_by_last4 = {
            (a.get("last4") or ""): a for a in connected_accounts if a.get("last4")
        }
        self.lab_accounts = lab_company_accounts  # keyed by account_key
        self.window = int(settings.get("transfer_pair_window_days", 3))
        self.card_window = int(settings.get("card_payment_window_days", 5))
        self.low_conf_max = float(settings.get(
            "low_confidence_pair_max_amt_usd", 25_000.0))

    # ---------- internal transfer + card payment pair matching --------

    def match_pairs(self, txns: list[dict]) -> dict:
        """Match connected-account pairs. Returns
        ``{txn_id: movement_info}``. Prefers pairs where at least one
        leg carries transfer language or matching last-4."""
        out: dict[str, dict] = {}
        # Bucket rows by absolute amount for O(n) matching.
        by_amt: dict[float, list[dict]] = {}
        for t in txns:
            if t.get("bank_account_id") not in self.connected:
                continue
            key = round(_abs_amt(t), 2)
            if key <= 0:
                continue
            by_amt.setdefault(key, []).append(t)

        used: set[str] = set()
        pairs_high = 0
        pairs_low = 0
        card_payments = 0

        for amt, group in by_amt.items():
            if len(group) < 2:
                continue
            # Sort by date so nearest pairs match first.
            group.sort(key=lambda r: (_parse_date(r.get("date")) or datetime.min))
            for i, a in enumerate(group):
                if a["id"] in used:
                    continue
                for b in group[i + 1:]:
                    if b["id"] in used or a["id"] == b["id"]:
                        continue
                    if a.get("bank_account_id") == b.get("bank_account_id"):
                        continue
                    if _direction_from_amount(a.get("amount")) == \
                       _direction_from_amount(b.get("amount")):
                        continue
                    da = _parse_date(a.get("date"))
                    dbb = _parse_date(b.get("date"))
                    if not (da and dbb):
                        continue
                    delta_days = abs((da - dbb).days)
                    if delta_days > max(self.window, self.card_window):
                        continue

                    a_acct = self.connected[a["bank_account_id"]]
                    b_acct = self.connected[b["bank_account_id"]]
                    a_type = a_acct.get("type") or ""
                    b_type = b_acct.get("type") or ""

                    # ------- CARD PAYMENT? -------
                    # Depository outflow pairs with credit card inflow.
                    is_card_pmt = False
                    if delta_days <= self.card_window:
                        if a_type == "credit" and b_type != "credit":
                            is_card_pmt = True
                        elif b_type == "credit" and a_type != "credit":
                            is_card_pmt = True

                    if is_card_pmt:
                        pair_id = str(uuid.uuid4())
                        card_payments += 1
                        out[a["id"]] = {
                            "movement_type":       "card_payment",
                            "movement_pair_id":    pair_id,
                            "movement_reason":     "bank outflow ↔ credit card inflow, equal amount",
                            "movement_confidence": "high",
                            "matched_txn_id":      b["id"],
                        }
                        out[b["id"]] = {
                            "movement_type":       "card_payment",
                            "movement_pair_id":    pair_id,
                            "movement_reason":     "bank outflow ↔ credit card inflow, equal amount",
                            "movement_confidence": "high",
                            "matched_txn_id":      a["id"],
                        }
                        used.add(a["id"]); used.add(b["id"])
                        break

                    if delta_days > self.window:
                        continue

                    # ------- INTERNAL TRANSFER -------
                    # High confidence when at least one leg has
                    # transfer language OR matching last-4 reference.
                    a_lang = has_transfer_language(a.get("description"))
                    b_lang = has_transfer_language(b.get("description"))
                    a_last4 = extract_dest_last4(a.get("description"))
                    b_last4 = extract_dest_last4(b.get("description"))
                    match_last4 = (
                        (a_last4 and a_last4 == b_acct.get("last4")) or
                        (b_last4 and b_last4 == a_acct.get("last4"))
                    )
                    confident = a_lang or b_lang or bool(match_last4)
                    if not confident and amt > self.low_conf_max:
                        # Avoid false-positive matching giant equal amounts.
                        continue
                    pair_id = str(uuid.uuid4())
                    if confident:
                        pairs_high += 1
                        conf = "high"
                    else:
                        pairs_low += 1
                        conf = "low"
                    reason_bits = []
                    if a_lang or b_lang: reason_bits.append("transfer language")
                    if match_last4:     reason_bits.append("matching last-4")
                    reason = ", ".join(reason_bits) or "equal amount, opposite direction, no language"
                    for x, y in ((a, b), (b, a)):
                        out[x["id"]] = {
                            "movement_type":       "internal_transfer",
                            "movement_pair_id":    pair_id,
                            "movement_reason":     reason,
                            "movement_confidence": conf,
                            "matched_txn_id":      y["id"],
                        }
                    used.add(a["id"]); used.add(b["id"])
                    break
        log.info("lab.step4 pairs: high=%d low=%d card_pmts=%d for %s",
                 pairs_high, pairs_low, card_payments, self.cid)
        return {"matches": out,
                "pairs_high": pairs_high,
                "pairs_low":  pairs_low,
                "card_payments": card_payments}

    # ---------- outside / payment_app / credit_line linking ----------

    def link_external(self, txns: list[dict],
                       already_matched: set[str]) -> dict:
        """For rows NOT matched to a connected pair, link movements
        to lab_company_accounts entries (outside / payment_app /
        credit_line)."""
        out: dict[str, dict] = {}
        outside_counts:    dict[str, int] = {}
        payment_app_counts: dict[str, int] = {}
        credit_line_counts: dict[str, int] = {}
        unpaired: dict[str, list] = {}

        for t in txns:
            if t["id"] in already_matched:
                continue
            desc = t.get("description") or ""
            low  = desc.lower()

            # 1) PayPal Credit REPAYMEN — before generic payment-app match.
            if "credit repaymen" in low and "paypal" in low:
                key = "credit_line_paypal_credit"
                out[t["id"]] = {
                    "movement_type":       "credit_line_payment",
                    "movement_reason":     "PayPal Credit Repayment — liability payment",
                    "movement_confidence": "high",
                    "linked_lab_account":  key,
                }
                credit_line_counts[key] = credit_line_counts.get(key, 0) + 1
                continue

            # 2) Outside account (transfer language + last4 not in connected)
            if has_transfer_language(desc):
                last4 = extract_dest_last4(desc)
                if last4 and last4 not in {a.get("last4") for a in self.connected.values() if a.get("last4")}:
                    key = f"outside_chk_{last4}"
                    out[t["id"]] = {
                        "movement_type":       "outside_transfer",
                        "movement_reason":     f"transfer to outside ···{last4}",
                        "movement_confidence": "high",
                        "linked_lab_account":  key,
                    }
                    outside_counts[key] = outside_counts.get(key, 0) + 1
                    continue
                # transfer language but no last4 / no match → unpaired
                out[t["id"]] = {
                    "movement_type":       "unpaired_transfer",
                    "movement_reason":     "transfer language, no matching leg or last-4",
                    "movement_confidence": "low",
                    "linked_lab_account":  None,
                }
                key = f"unpaired::{desc[:60]}"
                unpaired.setdefault(key, []).append(t["id"])
                continue

            # 3) Payment app (PayPal purchase / Venmo / Cash App)
            #    — only when the row's channel is a payment app.
            channel = classify_channel(
                description=desc,
                merchant=t.get("merchant"),
                counterparties=t.get("counterparties"),
                transaction_code=t.get("transaction_code"),
                payment_channel=t.get("payment_channel"),
                check_number=t.get("check_number"),
                parsed=parse_bank_desc(desc),
            )
            if channel == "payment_app":
                # A payment-app row is a *movement into the wrapper*
                # (funding, refund) OR a purchase — the Contact step
                # (Phase 2) decides. Phase 1 tags it as a
                # payment_app_transfer and links to the app's lab
                # account; that lets the CPA answer "is this app used
                # for business?" once.
                app_key = None
                for token, key in (("paypal", "payment_app_paypal"),
                                    ("venmo",  "payment_app_venmo"),
                                    ("cash app","payment_app_cashapp"),
                                    ("cashapp","payment_app_cashapp")):
                    if token in low:
                        app_key = key
                        break
                if app_key:
                    out[t["id"]] = {
                        "movement_type":       "payment_app_transfer",
                        "movement_reason":     f"routed via {app_key.replace('payment_app_','')}",
                        "movement_confidence": "high" if "credit repaymen" not in low else "low",
                        "linked_lab_account":  app_key,
                    }
                    payment_app_counts[app_key] = payment_app_counts.get(app_key, 0) + 1
                    continue
        return {
            "matches":            out,
            "outside_counts":     outside_counts,
            "payment_app_counts": payment_app_counts,
            "credit_line_counts": credit_line_counts,
            "unpaired":           unpaired,
        }


async def apply_step4(company_id: str, txns: list[dict],
                       connected: list[dict], settings: dict) -> dict:
    """Run Step 4 end-to-end and write results to ``lab_transactions``."""
    # Load current lab_company_accounts for this company (used for link_external)
    lab_accts = {}
    async for r in db.lab_company_accounts.find({"company_id": company_id}):
        lab_accts[r["account_key"]] = r

    matcher = MovementMatcher(
        company_id=company_id,
        connected_accounts=connected,
        lab_company_accounts=lab_accts,
        settings=settings,
    )
    pair_res = matcher.match_pairs(txns)
    matched_ids = set(pair_res["matches"].keys())
    ext_res = matcher.link_external(txns, matched_ids)

    all_matches: dict[str, dict] = {**pair_res["matches"], **ext_res["matches"]}
    for tid, info in all_matches.items():
        await db[LAB_TRANSACTIONS].update_one(
            {"company_id": company_id, "txn_id": tid},
            {"$set": info},
        )

    # Clear any old movement fields on rows that no longer match (idempotent
    # re-runs, e.g. after a settings change).
    await db[LAB_TRANSACTIONS].update_many(
        {"company_id": company_id, "txn_id": {"$nin": list(all_matches.keys())},
         "movement_type": {"$exists": True}},
        {"$unset": {"movement_type": "", "movement_pair_id": "",
                    "movement_reason": "", "movement_confidence": "",
                    "matched_txn_id": "", "linked_lab_account": ""}},
    )

    # LOAN_PAYMENTS routing (Feb-2026): any row Plaid tagged as a credit-
    # card payment (pfc_primary=LOAN_PAYMENTS or pfc_detailed=
    # LOAN_PAYMENTS_CREDIT_CARD_PAYMENT) is treated as a credit-line
    # payment regardless of channel — Plaid's PFC is authoritative for
    # this signal. Covers PayPal MstrCRD / SYF Paymnt, retailer card
    # portals (Best Buy, Concora, Synchrony, Comenity), and any bank-
    # channel autopay where the counterpart posting lives on a card
    # statement rather than in the bank feed.
    paypal_loan = await db[LAB_TRANSACTIONS].update_many(
        {"company_id":   company_id,
         "movement_type": {"$in": [None, "payment_app_transfer",
                                    "unpaired_transfer"]},
         "$or": [
            {"raw.pfc_primary":  "LOAN_PAYMENTS"},
            {"raw.pfc_detailed": "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"},
         ]},
        {"$set": {"movement_type":       "credit_line_payment",
                  "movement_reason":     "pfc LOAN_PAYMENTS",
                  "movement_confidence": 0.95}},
    )

    return {
        "pairs_high":         pair_res["pairs_high"],
        "pairs_low":          pair_res["pairs_low"],
        "card_payments":      pair_res["card_payments"],
        "outside_counts":     ext_res["outside_counts"],
        "payment_app_counts": ext_res["payment_app_counts"],
        "credit_line_counts": ext_res["credit_line_counts"],
        "unpaired_groups":    ext_res["unpaired"],
        "matched_total":      len(all_matches),
        "paypal_loan_reroute": paypal_loan.modified_count,
    }
