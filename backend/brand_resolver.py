"""Resolve the white-label brand a *company's* outbound surfaces should wear.

Mirrors the cascade in ``routes/pro.get_effective_branding`` (Enterprise →
Partner → Pro → platform) but is callable from emails and public token
pages where there is no logged-in user. Only tiers with white-label
unlocked win; otherwise the platform default is returned.
"""
from __future__ import annotations
import re
from typing import Optional

from db import db

PLATFORM = {"brand_name": "SmartBooks", "whitelabel": False, "slug": None, "logo_url": None,
            "theme_preset": "default", "theme_custom": None, "app_url": None}


def _wl_unlocked(u: Optional[dict]) -> bool:
    if not u:
        return False
    from routes.pro import _whitelabel_state
    return bool(_whitelabel_state(u).get("whitelabel_unlocked"))


async def brand_user_for_company(company_id: str) -> Optional[dict]:
    company = await db.companies.find_one({"id": company_id}) or {}
    pro_ms = await db.memberships.find({"company_id": company_id, "role": "pro"}).sort("created_at", -1).to_list(20)
    managing_pro = None
    for pm in pro_ms:
        p = await db.users.find_one({"id": pm["user_id"]})
        if p:
            managing_pro = p
            break
    if managing_pro and managing_pro.get("enterprise_id"):
        ent = await db.enterprises.find_one({"id": managing_pro["enterprise_id"]})
        if ent and ent.get("owner_user_id"):
            owner = await db.users.find_one({"id": ent["owner_user_id"]})
            if _wl_unlocked(owner):
                return owner
    partner_uid = company.get("partner_id") or (managing_pro or {}).get("partner_id")
    if not partner_uid and managing_pro and managing_pro.get("enterprise_id"):
        ent = await db.enterprises.find_one({"id": managing_pro["enterprise_id"]})
        partner_uid = (ent or {}).get("partner_id")
    if partner_uid:
        partner = await db.users.find_one({"id": partner_uid, "role": "partner"})
        if _wl_unlocked(partner):
            return partner
    if _wl_unlocked(managing_pro):
        return managing_pro
    return None


def brand_from_user(u: Optional[dict]) -> dict:
    if not u:
        return dict(PLATFORM)
    from routes.pro import _branding_out
    from email_dispatcher import public_base_url
    out = _branding_out(u)
    slug = out.get("signin_subdomain") or (u.get("branding") or {}).get("subdomain") or None
    name = (out.get("firm_name_raw") or "").strip()  # explicit Private Label Name only
    if not name:
        return dict(PLATFORM)
    logos = out.get("logos") or {}
    base = public_base_url(slug) if slug else public_base_url()
    logo_url = f"{base}/api/branding/logo/{slug}" if slug and (logos.get("logo_light") or out.get("logo_data_url")) else None
    return {"brand_name": name, "whitelabel": True, "slug": slug, "logo_url": logo_url,
            "theme_preset": out.get("theme_preset") or "default", "theme_custom": out.get("theme_custom"),
            "app_url": base}


async def resolve_company_brand(company_id: Optional[str]) -> dict:
    if not company_id:
        return dict(PLATFORM)
    try:
        return brand_from_user(await brand_user_for_company(company_id))
    except Exception:
        return dict(PLATFORM)


_FOOTER_RE = re.compile(r"Sent by SmartBooks(?: · <span style=\"font-family:monospace;\">smartbookssoftware\.ai</span>)?")
_POWERED_RE = re.compile(r"Powered by SmartBooks", re.I)


def apply_brand_to_html(html: str, brand: dict) -> str:
    """White-label an already-rendered email: footer, product-name mentions,
    link host, and a logo header when the brand has one."""
    if not brand or not brand.get("whitelabel"):
        return html
    name = brand["brand_name"]
    from html import escape
    from email_dispatcher import public_base_url
    tok = "\u0000BRAND\u0000"
    html = _FOOTER_RE.sub(f"Sent by {tok}", html)
    html = _POWERED_RE.sub(f"Powered by {tok}", html)
    host = (brand.get("app_url") or "").replace("https://", "").replace("http://", "")
    html = html.replace("smartbookssoftware.ai", host or tok)
    html = re.sub(r"\bSmartBooks\b", tok, html)
    html = html.replace(tok, escape(name))
    default_base = public_base_url()
    if brand.get("app_url") and brand["app_url"] != default_base:
        html = html.replace(default_base, brand["app_url"])
    if brand.get("logo_url") and "<tr><td>" in html:
        logo = (f'<tr><td style="padding:0 0 12px;text-align:left;"><img src="{brand["logo_url"]}" alt="{escape(name)}" '
                f'style="max-height:40px;max-width:200px;display:inline-block;" /></td></tr>')
        html = html.replace("<tr><td>", logo + "<tr><td>", 1)
    return html
