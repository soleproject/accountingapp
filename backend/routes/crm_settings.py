"""CRM settings + industry preset templates (Feb 2026, Phase C polish).

The CRM pipeline stage KEYS stay fixed (lead/qualified/proposal/
negotiation/won/lost) — that keeps deals-board queries, rollups, and
Deal→Project conversion simple. What CHANGES between industries is
what those stages are called, plus the default activity kinds and
lead-source options a rep sees.

A `crm_settings` doc per company holds:
    {company_id, preset (str|None), stage_labels: {key: str},
     activity_kinds: [str], lead_sources: [str], updated_at}

Endpoints:
    GET    /api/crm/presets                           — list 3 catalogue presets
    GET    /api/companies/{cid}/crm-settings          — current settings
    PATCH  /api/companies/{cid}/crm-settings          — partial override
    POST   /api/companies/{cid}/crm-settings/apply-preset {preset}
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from db import db, now_iso
from deps import require_company

router = APIRouter(prefix="/api")

# Fixed pipeline stage keys — never customized. Only labels vary.
_STAGE_KEYS = ["lead", "qualified", "proposal",
                "negotiation", "won", "lost"]

# Default (generic B2B) preset — used when a company has no settings yet.
_DEFAULT_LABELS = {
    "lead":        "Lead",
    "qualified":   "Qualified",
    "proposal":    "Proposal",
    "negotiation": "Negotiation",
    "won":         "Won",
    "lost":        "Lost",
}
_DEFAULT_ACTIVITY_KINDS = ["note", "call", "email", "meeting"]
_DEFAULT_LEAD_SOURCES = ["Referral", "Web", "Cold outreach",
                          "Trade show", "Partner"]

# Catalogue: three industry presets that reframe the same 6 stages
# and pre-seed activity kinds + lead sources so onboarding is one click.
PRESETS: dict = {
    "field_service": {
        "id": "field_service",
        "name": "Field Service",
        "tagline": "HVAC · Plumbing · Landscaping · anything with a truck roll",
        "stage_labels": {
            "lead":        "Estimate Requested",
            "qualified":   "Scheduled",
            "proposal":    "Quoted",
            "negotiation": "Onsite",
            "won":         "Invoiced & Paid",
            "lost":        "Cancelled",
        },
        "activity_kinds": ["note", "call", "site_visit", "quote_sent",
                            "photo_uploaded"],
        "lead_sources": ["Google Ads", "Referral", "Angi/HomeAdvisor",
                          "Yelp", "Walk-in", "Repeat customer"],
    },
    "agency": {
        "id": "agency",
        "name": "Agency",
        "tagline": "Creative · Digital · Marketing — retainer-driven pipelines",
        "stage_labels": {
            "lead":        "Discovery",
            "qualified":   "Brief Received",
            "proposal":    "Proposal Sent",
            "negotiation": "Contract Review",
            "won":         "Retainer Signed",
            "lost":        "Passed",
        },
        "activity_kinds": ["note", "call", "email", "meeting",
                            "proposal_sent", "kickoff"],
        "lead_sources": ["Referral", "Inbound web", "Cold outreach",
                          "LinkedIn", "Existing client", "Award listing"],
    },
    "cpa_firm": {
        "id": "cpa_firm",
        "name": "CPA / Accounting Firm",
        "tagline": "Tax prep · Advisory · Monthly close engagements",
        "stage_labels": {
            "lead":        "Inquiry",
            "qualified":   "Consultation",
            "proposal":    "Engagement Letter",
            "negotiation": "Docs Requested",
            "won":         "Active Client",
            "lost":        "Off-boarded",
        },
        "activity_kinds": ["note", "call", "email", "meeting",
                            "docs_requested", "letter_sent"],
        "lead_sources": ["Referral", "Chamber", "SBA", "Web",
                          "CPA network", "Repeat client"],
    },
}


def _clean(doc: dict) -> dict:
    if doc:
        doc.pop("_id", None)
    return doc


def _default_settings(cid: str) -> dict:
    """Shape returned when a company has no crm_settings doc yet.
    Prevents a 404 flicker on first open of /crm/settings."""
    return {
        "company_id": cid,
        "preset": None,
        "stage_labels": dict(_DEFAULT_LABELS),
        "activity_kinds": list(_DEFAULT_ACTIVITY_KINDS),
        "lead_sources": list(_DEFAULT_LEAD_SOURCES),
        # Follow-up thresholds (in days). "default" applies to any deal
        # whose most recent activity kind doesn't have its own override.
        "follow_up": {
            "default_days": 7,
            "per_activity": {},   # e.g. {"call": 3, "email": 5}
        },
        # Morning Brief AI summary on My Day — off by default; opt-in.
        "show_morning_brief": False,
    }


@router.get("/crm/presets")
async def list_presets(user: dict = Depends(get_current_user)) -> dict:
    """Static catalogue — safe to call unauthenticated-ish, but we
    still require a valid session so anonymous scrapers can't map
    our product surface."""
    return {"presets": list(PRESETS.values())}


@router.get("/companies/{cid}/crm-settings")
async def get_settings(
    cid: str, user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    doc = await db.crm_settings.find_one({"company_id": cid})
    return _clean(doc) if doc else _default_settings(cid)


@router.patch("/companies/{cid}/crm-settings")
async def patch_settings(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    """Partial override — merge on top of current settings."""
    await require_company(user, cid)
    current = await db.crm_settings.find_one({"company_id": cid})
    base = _clean(dict(current)) if current else _default_settings(cid)

    update: dict = {}
    if "stage_labels" in payload:
        labels = payload["stage_labels"] or {}
        if not isinstance(labels, dict):
            raise HTTPException(400, "stage_labels must be an object")
        # Whitelist keys against the fixed pipeline; ignore unknown keys.
        merged = dict(base.get("stage_labels") or _DEFAULT_LABELS)
        for k, v in labels.items():
            if k in _STAGE_KEYS and isinstance(v, str) and v.strip():
                merged[k] = v.strip()
        update["stage_labels"] = merged
    if "activity_kinds" in payload:
        ak = payload["activity_kinds"] or []
        if not isinstance(ak, list):
            raise HTTPException(400, "activity_kinds must be a list")
        # Dedupe + strip empties.
        cleaned = []
        seen = set()
        for x in ak:
            s = str(x or "").strip()
            if s and s not in seen:
                cleaned.append(s); seen.add(s)
        update["activity_kinds"] = cleaned or list(_DEFAULT_ACTIVITY_KINDS)
    if "lead_sources" in payload:
        ls = payload["lead_sources"] or []
        if not isinstance(ls, list):
            raise HTTPException(400, "lead_sources must be a list")
        cleaned = []
        seen = set()
        for x in ls:
            s = str(x or "").strip()
            if s and s not in seen:
                cleaned.append(s); seen.add(s)
        update["lead_sources"] = cleaned
    if "preset" in payload:
        p = payload["preset"]
        if p not in (None, "", "custom") and p not in PRESETS:
            raise HTTPException(400, f"preset must be one of {list(PRESETS)}")
        update["preset"] = p or "custom"
    if "follow_up" in payload:
        fu = payload["follow_up"] or {}
        if not isinstance(fu, dict):
            raise HTTPException(400, "follow_up must be an object")
        cleaned_fu: dict = {}
        if "default_days" in fu:
            try:
                d = int(fu["default_days"])
            except (TypeError, ValueError):
                raise HTTPException(400, "follow_up.default_days must be an integer")
            cleaned_fu["default_days"] = max(1, min(90, d))
        if "per_activity" in fu:
            pa = fu["per_activity"] or {}
            if not isinstance(pa, dict):
                raise HTTPException(400, "follow_up.per_activity must be an object")
            merged: dict = {}
            for k, v in pa.items():
                k = str(k or "").strip().lower()
                if not k:
                    continue
                try:
                    val = int(v)
                except (TypeError, ValueError):
                    continue
                merged[k] = max(1, min(90, val))
            cleaned_fu["per_activity"] = merged
        # Merge onto existing follow_up config
        existing_fu = (base.get("follow_up") or {}) if isinstance(base.get("follow_up"), dict) else {}
        update["follow_up"] = {**existing_fu, **cleaned_fu}
    if "show_morning_brief" in payload:
        update["show_morning_brief"] = bool(payload["show_morning_brief"])
    if not update:
        raise HTTPException(400, "No mutable fields in payload")

    update["updated_at"] = now_iso()
    # Upsert so a first-time PATCH creates the doc.
    await db.crm_settings.update_one(
        {"company_id": cid},
        {"$set": {**base, **update, "company_id": cid}},
        upsert=True)
    fresh = await db.crm_settings.find_one({"company_id": cid})
    return _clean(fresh)


@router.post("/companies/{cid}/crm-settings/apply-preset")
async def apply_preset(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    """One-click industry seed. Overwrites stage_labels + activity_kinds
    + lead_sources with the preset's values and stamps preset name."""
    await require_company(user, cid)
    preset_id = (payload or {}).get("preset")
    if preset_id not in PRESETS:
        raise HTTPException(400, f"preset must be one of {list(PRESETS)}")
    preset = PRESETS[preset_id]
    now = now_iso()
    doc = {
        "company_id": cid,
        "preset": preset_id,
        "stage_labels": dict(preset["stage_labels"]),
        "activity_kinds": list(preset["activity_kinds"]),
        "lead_sources": list(preset["lead_sources"]),
        "updated_at": now,
    }
    await db.crm_settings.update_one(
        {"company_id": cid}, {"$set": doc}, upsert=True)
    fresh = await db.crm_settings.find_one({"company_id": cid})
    return {"ok": True, "settings": _clean(fresh)}
