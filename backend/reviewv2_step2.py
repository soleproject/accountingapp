"""Step 2 classifier — verification-based auto-handle decision with
Brand Registry + LLM semantic classification.

Produces a rich per-transaction outcome:

  {
    "id": "...",
    "date": "...",
    "amount": ...,
    "merchant": "...",
    "description": "...",
    "contact_id": "...",
    "assigned_account": "...",  # ledger account name (or None)
    "verified": bool,
    "verification_reason": None | one of:
        "matched_transfer",
        "well_known_category_fits",
        "recognized_rule",
        "multi_purpose_default",
    "review_reason": None | one of:
        "category_mismatch",
        "payment_app_no_counterparty",
        "over_threshold",
        "sensitive_merchant_type",
        "llm_unsure",
        "orphan_transfer_leg",
        "unrecognized_merchant",
    "stage": "auto" | "stage1" | "stage2" | "stage3" | "always_review",
    "merchant_match": {
        "canonical_name": ...,
        "merchant_type":  ...,
        "status":         "approved" | "candidate" | None,
        "source":         "registry" | "llm" | None,
        "llm_reason":     "...",
    },
    "extras": { ... },
  }

Deterministic rules DECIDE auto vs review; LLM only PROPOSES.
"""
from __future__ import annotations
import logging
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


# Defaults per user's Step 2 spec — stored per-company on
# ``companies.review_v2_settings`` when the CPA overrides them.
DEFAULT_SETTINGS = {
    "multi_purpose_default_category":  "Office Supplies",
    "multi_purpose_flag_threshold":    250.0,
    "account_used_for_personal":       {},   # {bank_account_id: bool}
    "typical_spend_multiplier":        3.0,  # 3× median = well above typical
}


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


async def find_multi_purpose_default_account(
    company_id: str, target_name: str,
) -> Optional[dict]:
    """Find the closest expense account matching the per-company
    default. Never CREATES one — returns None if nothing matches.

    Matching strategy (deterministic):
      1. Exact case-insensitive name match on an active expense/COGS.
      2. Substring match ("Office" in name) with lowest code.
      3. None (caller routes to review).
    """
    target = (target_name or "").strip().lower()
    if not target:
        return None
    cur = db.accounts.find({
        "company_id": company_id,
        "active":     True,
        "type":       {"$in": ["expense", "cogs", "other-expense"]},
    })
    exact = None
    substring = None
    async for a in cur:
        name = (a.get("name") or "").strip().lower()
        if not name:
            continue
        if name == target:
            exact = a
            break
        if target in name and (substring is None or (a.get("code") or "z") < (substring.get("code") or "z")):
            substring = a
    return exact or substring


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
        # In-request memoization keyed by (merchant, pfc_detailed, direction)
        self._id_cache: dict[tuple, dict] = {}
        # Track PayPal ID diagnostics for the report.
        self.paypal_id_seen: dict[str, int] = {}
        self.paypal_id_matched_to: dict[str, str] = {}
        self.other_bank_paypal_rows: list[dict] = []
        # New registry candidates proposed during this run.
        self.new_candidates: list[dict] = []

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
    ) -> dict:
        key = (merchant or descriptor or "").strip().lower(), (pfc_detailed or ""), _txn_direction(amount)
        if key in self._id_cache:
            return self._id_cache[key]
        result = await identify_merchant(
            descriptor=descriptor, merchant_field=merchant,
            pfc_detailed=pfc_detailed, amount=amount,
            approved_registry_sample=self.approved_sample,
            stats=self.stats,
        )
        self._id_cache[key] = result
        return result

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
            "assigned_account":    None,
            "assigned_account_type": None,
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

        # ------ TRANSFER LEG PATH ------
        pair_id = t.get("transfer_pair_id")
        txn_type = (t.get("txn_type") or "").strip()
        if pair_id or txn_type == "Transfer":
            if not pair_id:
                result["stage"] = "stage1"
                result["review_reason"] = "orphan_transfer_leg"
                return result
            legs = (transfer_pair_map or {}).get(pair_id) or []
            both_connected = (
                len(legs) >= 2 and
                all(l.get("bank_account_id") in self.connected_ids for l in legs)
            )
            if both_connected:
                result["stage"] = "auto"
                result["verified"] = True
                result["verification_reason"] = "matched_transfer"
                result["merchant_match"] = {"source": "transfer_pair"}
            else:
                result["stage"] = "stage1"
                result["review_reason"] = "orphan_transfer_leg"
            return result

        # ------ BoA PayPal parse (before registry match — carries context)
        pp = classify_boa_paypal_row(t.get("description"), t.get("amount"))
        if pp:
            pk = pp["id_key"]
            self.paypal_id_seen[pk] = self.paypal_id_seen.get(pk, 0) + 1
            if pp["kind"] == "credit_repayment":
                result["stage"] = "always_review"
                result["review_reason"] = "sensitive_merchant_type"
                result["extras"]["paypal"] = pp
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
            # Fall through — bulk_match_registry / LLM will handle the id_value.
            result["extras"]["paypal"] = pp
        else:
            # If the row LOOKS like PayPal but not the BoA format, log
            # it for the report so we know how big the "other bank
            # formats" bucket is (per user's request).
            desc = (t.get("description") or "").lower()
            if "paypal" in desc and BOA_CO_ID_PAYPAL not in desc:
                self.other_bank_paypal_rows.append({
                    "description": (t.get("description") or "")[:180],
                    "amount": t.get("amount"),
                    "date": t.get("date"),
                })

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
            }
        else:
            # LLM path — expensive; called at most once per identity string
            # inside this classifier run.
            llm = await self._identify_via_llm(
                descriptor=(t.get("description") or "")[:200],
                merchant=identity_str,
                pfc_detailed=t.get("pfc_detailed"),
                amount=t.get("amount"),
            )
            if llm["match"] == "existing" and llm["canonical_name"]:
                # LLM says it matches an existing approved brand — reuse
                # the identity string as the canonical for this run
                # (an admin can approve the alias later).
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
                        "llm_reason":     llm["reason"],
                    }
            elif llm["match"] == "new" and llm["canonical_name"] and llm["merchant_type"]:
                # Propose a new registry candidate — persisted so a
                # later admin can approve. Even in read-only preview
                # we WRITE candidates (status=candidate) — approved-
                # only reporting simply won't return them until they're
                # approved.
                cand = await propose_candidate(
                    canonical_name=llm["canonical_name"],
                    aliases=[identity_str] if identity_str != llm["canonical_name"] else [],
                    merchant_type=llm["merchant_type"],
                    category_hint=llm["category_hint"],
                    proposed_by=f"reviewv2:{self.cid}",
                    llm_reason=llm["reason"],
                    llm_model="brand-llm",
                )
                # Track for the report
                self.new_candidates.append({
                    "id":             cand.get("id"),
                    "canonical_name": cand.get("canonical_name"),
                    "merchant_type":  cand.get("merchant_type"),
                    "category_hint":  cand.get("category_hint"),
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
                        "llm_reason":     llm["reason"],
                    }
                else:
                    result["stage"] = "stage3" if not t.get("contact_id") else "stage2"
                    result["review_reason"] = "unrecognized_merchant"
                    return result
            else:
                # LLM unsure or failed
                result["stage"] = "stage3" if not t.get("contact_id") else "stage2"
                result["review_reason"] = "llm_unsure"
                result["extras"]["llm_reason"] = llm.get("reason")
                return result

        # Track PayPal ID → matched brand map for the diagnostic list.
        if pp and pp.get("kind") == "purchase":
            self.paypal_id_matched_to.setdefault(
                pp["id_key"], result["merchant_match"].get("canonical_name") or "(unmatched)"
            )

        # ------ At this point we have a registry match. Apply Step 3 rules
        # (the rules themselves — multi_purpose auto-book, sensitive
        # types always review — are Step 3, but the classifier surfaces
        # the merchant_type + review/verified decision now so the CPA
        # can preview what Step 3 would do).
        mm = result["merchant_match"]
        mtype = mm.get("merchant_type")

        # Sensitive merchant types are always review.
        if mtype in SENSITIVE_MERCHANT_TYPES:
            result["stage"] = "always_review"
            result["review_reason"] = "sensitive_merchant_type"
            return result

        direction = _txn_direction(t.get("amount"))

        # Personal-use flag on the source account → always review for
        # multi_purpose merchants.
        bank_aid = t.get("bank_account_id")
        personal_flag = bool(
            self.settings.get("account_used_for_personal", {}).get(bank_aid, False)
        )
        if mtype == "multi_purpose" and personal_flag:
            result["stage"] = "always_review"
            result["review_reason"] = "sensitive_merchant_type"  # scoped by personal flag
            result["extras"]["personal_use"] = True
            return result

        # Amount threshold — Step 3 flags > threshold OR >> typical.
        threshold = float(self.settings.get("multi_purpose_flag_threshold") or 0.0)
        amt = abs(float(t.get("amount") or 0))
        # Median is keyed on the raw canonical string used to build the
        # medians map (the txn's own merchant / description tail), NOT
        # the registry's canonical name — the map is built that way.
        median_key = _brand_norm(_canonical_from_txn(t))
        median = self.merchant_medians.get(median_key)
        far_over_typical = (
            median is not None and median > 0
            and amt > (median * float(self.settings.get("typical_spend_multiplier") or 3.0))
            and amt > 100
        )
        over_threshold = (mtype == "multi_purpose" and amt > threshold) or far_over_typical
        if over_threshold:
            result["stage"] = "always_review"
            result["review_reason"] = "over_threshold"
            result["extras"]["threshold_hit"] = True

        # ------ category_fits check — LLM (cached).
        if cat and cat.get("name"):
            fit = await category_fits(
                merchant=mm.get("canonical_name") or identity_str,
                pfc_detailed=t.get("pfc_detailed"),
                amount=t.get("amount"),
                direction=direction,
                account_name=cat.get("name") or "",
                account_type=cat.get("type") or "",
                stats=self.stats,
            )
            result["extras"]["category_fits"] = fit
            if fit.get("reason") == "llm_unsure":
                if result["stage"] == "stage3":  # only downgrade if not already flagged
                    result["stage"] = "stage2" if t.get("contact_id") else "stage3"
                    result["review_reason"] = "llm_unsure"
                elif result["stage"] == "always_review":
                    pass  # keep the stronger review flag
            elif not fit.get("fits"):
                result["stage"] = "always_review"
                result["review_reason"] = "category_mismatch"
                return result

        # ------ Final verdict — if not already downgraded, verify.
        if result["stage"] == "always_review":
            return result

        if mtype == "multi_purpose" and not cat:
            # Would auto-book to the default category — if that account
            # exists on this book.
            default_name = self.settings.get("multi_purpose_default_category")
            default_acct = await find_multi_purpose_default_account(
                self.cid, default_name,
            )
            if default_acct:
                result["stage"] = "auto"
                result["verified"] = True
                result["verification_reason"] = "multi_purpose_default"
                result["extras"]["would_book_to"] = {
                    "id":   default_acct.get("id"),
                    "name": default_acct.get("name"),
                    "code": default_acct.get("code"),
                }
                return result
            # No matching account on this book — route to review
            result["stage"] = "stage2" if t.get("contact_id") else "stage3"
            result["review_reason"] = "unrecognized_merchant"
            result["extras"]["missing_default_account"] = default_name
            return result

        # Well-known + category exists + fits → verified as well-known.
        if mm.get("status") == "approved" and cat:
            result["stage"] = "auto"
            result["verified"] = True
            result["verification_reason"] = "well_known_category_fits"
            return result

        # Everything else — unrecognized / no rule yet.
        result["stage"] = "stage2" if t.get("contact_id") else "stage3"
        result["review_reason"] = result["review_reason"] or "unrecognized_merchant"
        return result
