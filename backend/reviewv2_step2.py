"""Step 2 classifier — verification-based auto-handle decision with
Brand Registry + LLM semantic classification.

Produces a rich per-transaction outcome:

  {
    "id": "...",
    ...
    "verified": bool,
    "verification_reason": None | one of:
        "matched_transfer",
        "well_known_category_fits",
        "single_purpose_category_fits",
        "multi_purpose_existing_category",
        "recognized_rule",
    "review_reason": None | one of:
        "category_mismatch",
        "payment_app_no_counterparty",
        "over_threshold",
        "sensitive_merchant_type",
        "personal_risk_uncategorized",
        "wire_needs_counterparty",
        "credit_card_payment",
        "llm_unsure",
        "orphan_transfer_leg",
        "unpaired_transfer_candidate",
        "unrecognized_merchant",
        "uncategorized_multi_purpose",
    "stage": "auto" | "stage1" | "stage2" | "stage3" | "always_review",
    "merchant_match": { ... },
    "extras": { ... },
  }

Deterministic rules DECIDE auto vs review; LLM only PROPOSES.
"""
from __future__ import annotations
import logging
import re
from typing import Any, Optional

from db import db
from brand_registry import (
    lookup_many, propose_candidate,
    SENSITIVE_MERCHANT_TYPES, _norm as _brand_norm,
)
from brand_llm import (
    BrandLLMStats, identify_merchant, category_fits,
)
from paypal_parser import (
    classify_boa_paypal_row, has_indn, extract_indn, BOA_CO_ID_PAYPAL,
)

log = logging.getLogger("axiom.reviewv2.step2")


# Defaults per Step 2 spec (v2 — no default category; multi_purpose
# keeps whatever the categorization engine already assigned).
DEFAULT_SETTINGS = {
    "multi_purpose_flag_threshold":    250.0,
    "account_used_for_personal":       {},   # {bank_account_id: bool}
    "typical_spend_multiplier":        3.0,  # 3× median = well above typical
}


# Regex for own-account transfer language on rows that don't have a
# transfer_pair_id stamped. These should be evaluated as transfer
# CANDIDATES, not slotted into category_mismatch.
_TRANSFER_LANG_RX = re.compile(
    r"\b("
    r"DDA\s*TO\s*DDA|"
    r"DDA\s*FR\s*DDA|"
    r"TRANSFER\s+TO|TRANSFER\s+FROM|"
    r"ONLINE\s+TRANSFER|ONLINE\s+BANKING\s+TRANSFER|"
    r"INTRA[- ]?BANK\s+TRANSFER|"
    r"INTERNAL\s+TRANSFER|"
    r"ACCT\s+TRANSFER|ACCT\s+XFER|"
    r"BOOK\s+TRANSFER|"
    r"WIRE\s+TRANSFER"
    r")\b",
    re.IGNORECASE,
)


def looks_like_transfer(description: str | None) -> bool:
    return bool(_TRANSFER_LANG_RX.search(description or ""))


async def get_settings(company_id: str) -> dict:
    doc = await db.companies.find_one({"id": company_id}, {"review_v2_settings": 1})
    stored = (doc or {}).get("review_v2_settings") or {}
    return {**DEFAULT_SETTINGS, **stored}


def _txn_direction(amount: float | int | None) -> str:
    return "in" if float(amount or 0) > 0 else "out"


def _canonical_from_txn(t: dict) -> str:
    """Best-effort canonical merchant string for registry lookup.
    Preference order: Plaid ``merchant``, first non-payment_app
    counterparty, description tail after the payment-app prefix."""
    m = (t.get("merchant") or "").strip()
    if m:
        return m
    for cp in (t.get("counterparties") or []):
        if (cp.get("type") or "").lower() == "payment_app":
            continue
        name = (cp.get("name") or "").strip()
        if name:
            return name
    return (t.get("description") or "").strip()[:80]


class Step2Classifier:
    """Ephemeral, per-request classifier. Holds the shared merchant
    cache, LLM stats, and per-company config so calls that reuse the
    same merchant/account key don't hit the LLM twice."""

    def __init__(
        self, *,
        company_id: str,
        connected_ids: set[str],
        accts_by_id: dict[str, dict],
        settings: dict,
        include_candidates: bool,
        approved_sample: list[str],
        merchant_medians: dict[str, float],
    ) -> None:
        self.cid = company_id
        self.connected_ids = connected_ids
        self.accts_by_id = accts_by_id
        self.settings = settings
        self.include_candidates = include_candidates
        self.approved_sample = approved_sample
        self.merchant_medians = merchant_medians
        self.stats = BrandLLMStats()
        # CoA expense/COGS names (used to constrain suggested_category).
        self.coa_expense_names = sorted({
            (a.get("name") or "").strip()
            for a in accts_by_id.values()
            if (a.get("type") or "").lower() in
               ("expense", "cogs", "other-expense", "other expense",
                "equity")  # equity lets Owner's Draw show up
            and (a.get("name") or "").strip()
        })
        # In-request memoization keyed by (merchant, pfc_detailed, direction)
        self._id_cache: dict[tuple, dict] = {}
        # Track PayPal ID diagnostics for the report.
        self.paypal_id_seen: dict[str, int] = {}
        self.paypal_id_matched_to: dict[str, str] = {}
        self.other_bank_paypal_rows: list[dict] = []
        # New registry candidates proposed during this run.
        self.new_candidates: list[dict] = []
        # Rows with transfer-like language but no transfer_pair_id.
        self.unpaired_transfer_candidates: list[dict] = []

    # -------------------------------------------------- registry match

    def _statuses(self) -> tuple[str, ...]:
        return ("approved", "candidate") if self.include_candidates else ("approved",)

    async def bulk_match_registry(self, names: list[str]) -> dict[str, dict]:
        """Batch-lookup so we make ONE Mongo query per classifier run.
        Returns ``{original_name: registry_doc}``."""
        return await lookup_many(names, statuses=self._statuses())

    async def _identify_via_llm(
        self, *, descriptor: str, merchant: str | None,
        pfc_detailed: str | None, amount: float | None,
        model_override: str | None = None,
    ) -> dict:
        key = (merchant or descriptor or "").strip().lower(), (pfc_detailed or ""), _txn_direction(amount), (model_override or "")
        if key in self._id_cache:
            return self._id_cache[key]
        result = await identify_merchant(
            descriptor=descriptor, merchant_field=merchant,
            pfc_detailed=pfc_detailed, amount=amount,
            approved_registry_sample=self.approved_sample,
            stats=self.stats,
            model_override=model_override,
        )
        self._id_cache[key] = result
        return result

    async def retry_llm_unsure_with_stronger_model(
        self, rows_and_txns: list[tuple[dict, dict]],
        transfer_pair_map: dict[str, list[dict]] | None,
        stronger_model: str = "gpt-4o",
    ) -> dict:
        """For every row where `review_reason == 'llm_unsure'`, re-run
        `identify_merchant` with the stronger model. When the retry
        returns match=existing|new, cache the result so the follow-up
        `classify` picks it up and re-classify that txn. Returns a
        summary of how many rows were resolved and their new stages.
        """
        stats = BrandLLMStats()
        resolved = 0
        still_unsure = 0
        by_new_stage: dict[str, int] = {}
        updated_rows: list[tuple[int, dict]] = []
        for idx, (row, t) in enumerate(rows_and_txns):
            if row.get("review_reason") != "llm_unsure":
                continue
            descriptor = (t.get("description") or "")[:200]
            merchant = _canonical_from_txn(t)
            retry = await identify_merchant(
                descriptor=descriptor, merchant_field=merchant,
                pfc_detailed=t.get("pfc_detailed"),
                amount=t.get("amount"),
                approved_registry_sample=self.approved_sample,
                stats=stats,
                model_override=stronger_model,
            )
            if retry.get("match") in ("existing", "new"):
                # Seed the in-request cache with the stronger result so
                # the re-classify short-circuits through it.
                key = (merchant or descriptor or "").strip().lower(), (t.get("pfc_detailed") or ""), _txn_direction(t.get("amount")), ""
                self._id_cache[key] = retry
                # Also persist as a candidate if match=new so the next
                # cold run picks it up from the registry.
                if retry["match"] == "new" and retry.get("canonical_name") and retry.get("merchant_type"):
                    await propose_candidate(
                        canonical_name=retry["canonical_name"],
                        aliases=[merchant] if merchant and merchant != retry["canonical_name"] else [],
                        merchant_type=retry["merchant_type"],
                        category_hint=retry.get("category_hint"),
                        proposed_by=f"reviewv2:{self.cid}:stronger",
                        llm_reason=retry.get("reason"),
                        llm_model=stronger_model,
                        personal_risk=bool(retry.get("personal_risk")),
                    )
                new_row = await self.classify(t, transfer_pair_map=transfer_pair_map)
                new_row.setdefault("extras", {})["stronger_retry"] = {
                    "match":          retry.get("match"),
                    "canonical_name": retry.get("canonical_name"),
                    "merchant_type":  retry.get("merchant_type"),
                    "reason":         retry.get("reason"),
                }
                updated_rows.append((idx, new_row))
                if new_row.get("review_reason") != "llm_unsure":
                    resolved += 1
                    by_new_stage[new_row["stage"]] = by_new_stage.get(new_row["stage"], 0) + 1
                else:
                    still_unsure += 1
            else:
                still_unsure += 1
        return {
            "attempted":    resolved + still_unsure,
            "resolved":     resolved,
            "still_unsure": still_unsure,
            "by_new_stage": by_new_stage,
            "updated_rows": updated_rows,
            "stats":        stats.as_dict(),
            "model":        stronger_model,
        }

    # -------------------------------------------------- top-level classify

    async def classify(
        self, t: dict, *,
        transfer_pair_map: dict[str, list[dict]] | None = None,
    ) -> dict:
        """Return the rich outcome dict for a single transaction."""
        result: dict[str, Any] = {
            "id":          t.get("id"),
            "date":        t.get("date"),
            "amount":      t.get("amount"),
            "merchant":    t.get("merchant"),
            "description": t.get("description"),
            "contact_id":  t.get("contact_id"),
            "pfc_detailed": t.get("pfc_detailed"),
            "pfc_primary": t.get("pfc_primary"),
            "counterparties": t.get("counterparties") or [],
            "bank_account_id": t.get("bank_account_id"),
            "assigned_account":    None,
            "assigned_account_type": None,
            "human_reviewed":     bool(t.get("human_reviewed")),
            "verified":            False,
            "verification_reason": None,
            "review_reason":       None,
            "stage":               "stage3",
            "merchant_match":      {},
            "extras":              {},
        }

        cat_id = t.get("category_account_id")
        cat = self.accts_by_id.get(cat_id) if cat_id else None
        if cat:
            result["assigned_account"] = cat.get("name")
            result["assigned_account_type"] = cat.get("type")
        cat_name_low = (cat.get("name") or "").lower() if cat else ""
        is_uncategorized = (
            not cat or "uncategor" in cat_name_low
            or (cat.get("code") or "").startswith("9999")
        )

        # ------ WIRE ROUTING — skip LLM entirely.
        # Plaid stamps TRANSFER_IN_WIRE / TRANSFER_OUT_WIRE on every
        # wire regardless of counterparty. We ask the client who sent
        # it / who they sent it to instead of trying to identify a
        # phantom merchant.
        pfc_d = (t.get("pfc_detailed") or "").upper()
        if pfc_d in ("TRANSFER_IN_WIRE", "TRANSFER_OUT_WIRE"):
            result["stage"] = "stage3"
            result["review_reason"] = "wire_needs_counterparty"
            result["extras"]["wire_direction"] = (
                "in" if pfc_d == "TRANSFER_IN_WIRE" else "out"
            )
            result["extras"]["stage3_question"] = (
                "Who sent this wire, and what was it for?"
                if pfc_d == "TRANSFER_IN_WIRE"
                else "Who did you wire this to, and what was it for?"
            )
            return result

        # ------ TRANSFER LEG PATH (both a stamped pair_id and the
        # legacy txn_type=="Transfer" trigger it).
        pair_id = t.get("transfer_pair_id")
        txn_type = (t.get("txn_type") or "").strip()
        if pair_id or txn_type == "Transfer":
            if not pair_id:
                result["stage"] = "stage1"
                result["review_reason"] = "orphan_transfer_leg"
                result["extras"]["leg_bank_id"] = t.get("bank_account_id")
                return result
            legs = (transfer_pair_map or {}).get(pair_id) or []
            both_connected = (
                len(legs) >= 2 and
                all(l.get("bank_account_id") in self.connected_ids for l in legs)
            )
            result["extras"]["pair_id"] = pair_id
            result["extras"]["leg_count"] = len(legs)
            result["extras"]["legs_bank_ids"] = [l.get("bank_account_id") for l in legs]
            if both_connected:
                result["stage"] = "auto"
                result["verified"] = True
                result["verification_reason"] = "matched_transfer"
                result["merchant_match"] = {"source": "transfer_pair"}
            else:
                result["stage"] = "stage1"
                result["review_reason"] = "orphan_transfer_leg"
            return result

        # ------ TRANSFER LANGUAGE without a pair — evaluate as
        # unpaired-transfer-candidate BEFORE brand matching so we
        # don't burn an LLM call on it and don't misclassify it as
        # category_mismatch.
        if looks_like_transfer(t.get("description")):
            self.unpaired_transfer_candidates.append({
                "id":          t.get("id"),
                "date":        t.get("date"),
                "amount":      t.get("amount"),
                "description": (t.get("description") or "")[:180],
                "bank_account_id": t.get("bank_account_id"),
                "assigned_account": result["assigned_account"],
            })
            result["stage"] = "stage1"
            result["review_reason"] = "unpaired_transfer_candidate"
            result["extras"]["assigned_account"] = result["assigned_account"]
            return result

        # ------ BoA PayPal parse (before registry match — carries context)
        pp = classify_boa_paypal_row(t.get("description"), t.get("amount"))
        if pp:
            pk = pp["id_key"]
            self.paypal_id_seen[pk] = self.paypal_id_seen.get(pk, 0) + 1
            if pp["kind"] == "credit_repayment":
                result["stage"] = "stage1"
                result["review_reason"] = "credit_card_payment"
                result["extras"]["paypal"] = pp
                result["extras"]["card_key"] = "PayPal Credit"
                result["extras"]["stage1_question"] = (
                    "Is your PayPal Credit account used for the business?"
                )
                return result
            if pp["kind"] == "inflow":
                result["stage"] = "stage2" if t.get("contact_id") else "stage3"
                result["review_reason"] = "unrecognized_merchant"
                result["extras"]["paypal"] = pp
                return result
            # kind == "purchase" — the ID value is the merchant to match.
            result["extras"]["paypal"] = pp
            result["extras"]["payment_method"] = "PayPal"
            # Contact is the resolved merchant (set later once matched);
            # payment_method is the wrapper. We surface both so the CPA
            # sees "Panda Express via PayPal", never just "PayPal".
        else:
            desc = (t.get("description") or "").lower()
            if "paypal" in desc and BOA_CO_ID_PAYPAL not in desc:
                self.other_bank_paypal_rows.append({
                    "description": (t.get("description") or "")[:180],
                    "amount": t.get("amount"),
                    "date": t.get("date"),
                })

        # ------ ZELLE — route to stage2 by extracted counterparty.
        # Zelle memos carry the real counterparty ("Zelle payment to
        # Kevin Petersen Conf#XXX"). The existing helper in
        # contact_resolver already knows how to pull it. Rows with an
        # identifiable counterparty go to stage2 as (counterparty,
        # direction); opaque Zelle memos fall through to stage3.
        merch_low = (t.get("merchant") or "").strip().lower()
        desc_low  = (t.get("description") or "").lower()
        is_zelle = (
            merch_low == "zelle" or
            "zelle" in desc_low or
            "zelle" in {(cp.get("name") or "").strip().lower()
                        for cp in (t.get("counterparties") or [])}
        )
        if is_zelle:
            from contact_resolver import extract_p2p_counterparty as _cp_extract
            zelle_cp = _cp_extract(
                merchant=t.get("merchant"),
                description=t.get("description"),
                original_description=t.get("original_description"),
                counterparties=t.get("counterparties"),
            )
            # If regex fails but the row already carries a contact_id
            # (e.g. contact_resolver linked it earlier), route to
            # stage2 by that contact — never send a Zelle-with-contact
            # into stage3 just because our memo parser missed.
            if zelle_cp or t.get("contact_id"):
                result["stage"] = "stage2"
                result["review_reason"] = "unrecognized_merchant"
                result["extras"]["payment_method"] = "Zelle"
                if zelle_cp:
                    result["extras"]["extracted_counterparty"] = zelle_cp
                result["extras"]["contact_direction"] = _txn_direction(t.get("amount"))
                return result
            # opaque Zelle → stage3
            result["stage"] = "stage3"
            result["review_reason"] = "payment_app_no_counterparty"
            result["extras"]["payment_method"] = "Zelle"
            result["extras"]["stage3_question"] = (
                "Who was this Zelle to/from, and what was it for?"
            )
            return result

        # ------ VENMO: only counterparty is Venmo itself?
        cps = t.get("counterparties") or []
        non_pa_cps = [
            cp for cp in cps
            if (cp.get("type") or "").lower() != "payment_app"
            and (cp.get("name") or "").strip().lower() not in ("venmo",)
        ]
        if (t.get("merchant") or "").strip().lower() == "venmo" and not non_pa_cps:
            result["stage"] = "stage3"
            result["review_reason"] = "payment_app_no_counterparty"
            result["extras"]["stage3_question"] = (
                "Who was this to, and what was it for?"
            )
            return result

        # ------ Choose the identity string
        if pp and pp.get("kind") == "purchase":
            identity_str = pp["id_value"]
        else:
            identity_str = _canonical_from_txn(t)

        # ------ Registry match (fast path)
        reg_map = await self.bulk_match_registry([identity_str])
        reg = reg_map.get(identity_str)
        if reg:
            result["merchant_match"] = {
                "canonical_name": reg.get("canonical_name"),
                "merchant_type":  reg.get("merchant_type"),
                "status":         reg.get("status"),
                "source":         "registry",
                "category_hint":  reg.get("category_hint"),
                "personal_risk":  bool(reg.get("personal_risk")),
            }
        else:
            llm = await self._identify_via_llm(
                descriptor=(t.get("description") or "")[:200],
                merchant=identity_str,
                pfc_detailed=t.get("pfc_detailed"),
                amount=t.get("amount"),
            )
            result["extras"]["llm_result"] = {
                "match":         llm.get("match"),
                "canonical_name": llm.get("canonical_name"),
                "merchant_type":  llm.get("merchant_type"),
                "confidence":    llm.get("confidence"),
                "unsure_cause":  llm.get("unsure_cause"),
                "reason":        llm.get("reason"),
                "prompt_inputs": llm.get("prompt_inputs"),
            }
            if llm["match"] == "existing" and llm["canonical_name"]:
                reg = await lookup_many(
                    [llm["canonical_name"]], statuses=self._statuses()
                )
                reg = reg.get(llm["canonical_name"])
                if reg:
                    result["merchant_match"] = {
                        "canonical_name": reg.get("canonical_name"),
                        "merchant_type":  reg.get("merchant_type"),
                        "status":         reg.get("status"),
                        "source":         "llm→registry",
                        "category_hint":  reg.get("category_hint"),
                        "personal_risk":  bool(reg.get("personal_risk")),
                        "llm_reason":     llm["reason"],
                    }
            elif llm["match"] == "new" and llm["canonical_name"] and llm["merchant_type"]:
                cand = await propose_candidate(
                    canonical_name=llm["canonical_name"],
                    aliases=[identity_str] if identity_str != llm["canonical_name"] else [],
                    merchant_type=llm["merchant_type"],
                    category_hint=llm["category_hint"],
                    proposed_by=f"reviewv2:{self.cid}",
                    llm_reason=llm["reason"],
                    llm_model="brand-llm",
                    personal_risk=bool(llm.get("personal_risk")),
                )
                self.new_candidates.append({
                    "id":             cand.get("id"),
                    "canonical_name": cand.get("canonical_name"),
                    "merchant_type":  cand.get("merchant_type"),
                    "category_hint":  cand.get("category_hint"),
                    "personal_risk":  cand.get("personal_risk", False),
                    "aliases":        cand.get("aliases", [])[:6],
                    "llm_reason":     llm["reason"],
                })
                if self.include_candidates:
                    result["merchant_match"] = {
                        "canonical_name": cand.get("canonical_name"),
                        "merchant_type":  cand.get("merchant_type"),
                        "status":         "candidate",
                        "source":         "llm",
                        "category_hint":  cand.get("category_hint"),
                        "personal_risk":  bool(cand.get("personal_risk")),
                        "llm_reason":     llm["reason"],
                    }
                else:
                    result["stage"] = "stage3" if not t.get("contact_id") else "stage2"
                    result["review_reason"] = "unrecognized_merchant"
                    return result
            else:
                result["stage"] = "stage3" if not t.get("contact_id") else "stage2"
                result["review_reason"] = "llm_unsure"
                result["extras"]["llm_unsure_cause"] = llm.get("unsure_cause")
                result["extras"]["llm_reason"] = llm.get("reason")
                return result

        if pp and pp.get("kind") == "purchase":
            self.paypal_id_matched_to.setdefault(
                pp["id_key"], result["merchant_match"].get("canonical_name") or "(unmatched)"
            )

        # ------ At this point we have a registry match. Apply merchant_type rules.
        mm = result["merchant_match"]
        mtype = mm.get("merchant_type")

        # Sensitive merchant types are always review.
        # credit_card gets special stage1 grouping — one card per card
        # account. Everything else in SENSITIVE_MERCHANT_TYPES stays
        # in always_review.
        if mtype == "credit_card":
            result["stage"] = "stage1"
            result["review_reason"] = "credit_card_payment"
            result["extras"]["card_key"] = mm.get("canonical_name") or "unknown_card"
            return result
        if mtype in SENSITIVE_MERCHANT_TYPES:
            result["stage"] = "always_review"
            result["review_reason"] = "sensitive_merchant_type"
            return result

        direction = _txn_direction(t.get("amount"))
        amt = abs(float(t.get("amount") or 0))
        bank_aid = t.get("bank_account_id")
        personal_flag = bool(
            self.settings.get("account_used_for_personal", {}).get(bank_aid, False)
        )

        # ==== MULTI-PURPOSE HANDLING (v2) =====================
        # KEEP the categorization engine's category. Skip category_fits.
        # Only route to review under specific conditions.
        if mtype == "multi_purpose":
            # Personal-use bank flag → review regardless of amount.
            if personal_flag:
                result["stage"] = "always_review"
                result["review_reason"] = "sensitive_merchant_type"
                result["extras"]["personal_use"] = True
                return result
            # Uncategorized → review (can't auto-handle without a category).
            if is_uncategorized:
                result["stage"] = "stage2" if t.get("contact_id") else "stage3"
                result["review_reason"] = "uncategorized_multi_purpose"
                return result
            # Threshold or far-over-typical → keep booked, one-tap confirm.
            threshold = float(self.settings.get("multi_purpose_flag_threshold") or 0.0)
            median_key = _brand_norm(_canonical_from_txn(t))
            median = self.merchant_medians.get(median_key)
            far_over_typical = (
                median is not None and median > 0
                and amt > (median * float(self.settings.get("typical_spend_multiplier") or 3.0))
                and amt > 100
            )
            if amt > threshold or far_over_typical:
                result["stage"] = "always_review"
                result["review_reason"] = "over_threshold"
                result["extras"]["threshold_hit"] = True
                result["extras"]["would_stay_booked_to"] = result["assigned_account"]
                return result
            # Otherwise auto-handle keeping the existing pfc-based category.
            result["stage"] = "auto"
            result["verified"] = True
            result["verification_reason"] = "multi_purpose_existing_category"
            return result
        # ==== END MULTI-PURPOSE ================================

        # ==== NON-MULTI-PURPOSE (merchant / utility / insurance) ====
        # personal_risk is a LABEL — it only routes to review when the
        # bank account is marked personal-use. On its own it doesn't
        # push a row into review.
        if mm.get("personal_risk") and personal_flag:
            result["stage"] = "always_review"
            result["review_reason"] = "sensitive_merchant_type"
            result["extras"]["personal_use"] = True
            return result

        # Amount far above typical spend AND above threshold →
        # over_threshold. Both conditions must hold so recurring
        # in-band charges (AT&T monthly bills) don't get flagged just
        # for crossing the raw threshold.
        threshold_pre = float(self.settings.get("multi_purpose_flag_threshold") or 0.0)
        median_key = _brand_norm(_canonical_from_txn(t))
        median = self.merchant_medians.get(median_key)
        far_over_typical = (
            median is not None and median > 0
            and amt > (median * float(self.settings.get("typical_spend_multiplier") or 3.0))
            and amt > 100
        )
        if far_over_typical and amt > threshold_pre:
            result["stage"] = "always_review"
            result["review_reason"] = "over_threshold"
            result["extras"]["threshold_hit"] = True
            return result

        # Uncategorized row → can't verify.
        if is_uncategorized:
            result["stage"] = "stage2" if t.get("contact_id") else "stage3"
            result["review_reason"] = "unrecognized_merchant"
            result["extras"]["uncategorized"] = True
            return result

        # category_fits check — only for non-multi_purpose brands.
        if cat and cat.get("name"):
            fit = await category_fits(
                merchant=mm.get("canonical_name") or identity_str,
                pfc_detailed=t.get("pfc_detailed"),
                amount=t.get("amount"),
                direction=direction,
                account_name=cat.get("name") or "",
                account_type=cat.get("type") or "",
                coa_expense_names=self.coa_expense_names,
                stats=self.stats,
            )
            result["extras"]["category_fits"] = fit
            if fit.get("reason") == "llm_unsure":
                result["stage"] = "stage2" if t.get("contact_id") else "stage3"
                result["review_reason"] = "llm_unsure"
                result["extras"]["llm_unsure_cause"] = "category_fits_uncertain"
                return result
            if not fit.get("fits"):
                result["stage"] = "always_review"
                result["review_reason"] = "category_mismatch"
                # suggested_category surfaces on the mismatch card as a
                # one-tap fix — passed through as-is.
                result["extras"]["suggested_category"] = fit.get("suggested_category")
                return result

        threshold = float(self.settings.get("multi_purpose_flag_threshold") or 0.0)

        # Well-known + category fits → verified. Threshold flag only
        # fires when amount is BOTH above threshold AND well above the
        # merchant's typical spend (recurring in-band bills like AT&T
        # monthly should not get flagged just for crossing the raw
        # $250 threshold).
        if mm.get("status") == "approved" and cat:
            if amt > threshold and far_over_typical:
                result["stage"] = "always_review"
                result["review_reason"] = "over_threshold"
                result["extras"]["threshold_hit"] = True
                return result
            result["stage"] = "auto"
            result["verified"] = True
            result["verification_reason"] = "well_known_category_fits"
            return result

        # ==== LOCAL SINGLE-PURPOSE AUTO-HANDLE (Step 3) ==========
        # A candidate-only (not yet approved) single-purpose merchant
        # auto-handles when every guardrail is green. This lets the
        # LLM's proposal drive auto-book without waiting on admin
        # approval — subject to the per-client threshold + personal-
        # risk / personal-use gates.
        if (
            mtype == "merchant"
            and cat and cat.get("name")
            and not mm.get("personal_risk")
            and amt <= threshold
        ):
            fit = result["extras"].get("category_fits") or {}
            if fit.get("fits") is True and fit.get("reason") != "llm_unsure":
                result["stage"] = "auto"
                result["verified"] = True
                result["verification_reason"] = "single_purpose_category_fits"
                return result

        # Everything else — unrecognized / no rule yet.
        result["stage"] = "stage2" if t.get("contact_id") else "stage3"
        result["review_reason"] = "unrecognized_merchant"
        return result
