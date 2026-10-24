"""Practice product — per-user profile settings (superadmin-only shell for now)."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional
from pydantic import BaseModel, Field
import uuid
from fastapi import APIRouter, Depends, HTTPException

from db import db
from auth import require_role

router = APIRouter(prefix="/api/practice")
_guard = require_role("superadmin")


class PracticeProfile(BaseModel):
    first_name: str = ""
    middle_name: str = ""
    last_name: str = ""
    job_title: str = ""
    mobile: str = ""
    email: str = ""
    time_zone: str = "(UTC-08:00) Pacific Time (US & Canada)"
    home_phone: str = ""
    office_phone: str = ""
    hourly_rate: float = Field(0.0, ge=0)
    round_time_entries: bool = False
    daily_agenda_email: bool = True
    profile_picture: Optional[str] = None


def _defaults(user: dict) -> dict:
    parts = (user.get("name") or "").split(" ")
    return PracticeProfile(
        first_name=parts[0] if parts else "",
        last_name=" ".join(parts[1:]),
        email=user.get("email") or "",
    ).model_dump()


@router.get("/profile")
async def get_profile(user: dict = Depends(_guard)):
    doc = await db.practice_profiles.find_one({"user_id": user["id"]}, {"_id": 0, "user_id": 0})
    return doc or {**_defaults(user), "saved": False}


@router.put("/profile")
async def put_profile(inp: PracticeProfile, user: dict = Depends(_guard)):
    data = {**inp.model_dump(), "saved": True, "updated_at": datetime.now(timezone.utc).isoformat()}
    await db.practice_profiles.update_one({"user_id": user["id"]}, {"$set": data}, upsert=True)
    return data


class PracticePerson(BaseModel):
    first_name: str = ""
    middle_name: str = ""
    last_name: str = ""
    home: str = ""
    mobile: str = ""
    office: str = ""
    fax: str = ""
    email: str = ""
    client_portal: bool = False
    notes: str = ""
    preferred_contact_method: str = ""


class PracticePortalSettings(BaseModel):
    show_unpaid_invoices: bool = True
    show_paid_invoices: bool = True
    show_account_balances: bool = False
    show_all_payments: bool = True
    send_payment_reminders: bool = True


class PracticeContactIn(BaseModel):
    company_name: str = ""
    company_notes: str = ""
    contacts: list[PracticePerson] = Field(default_factory=list)
    address: str = ""
    assigned_to: str = ""
    tags: list[str] = Field(default_factory=list)
    status: str = "Active"
    number: Optional[str] = None
    website: str = ""
    additional_invoice_recipients: str = ""
    invoice_template: str = ""
    portal_settings: PracticePortalSettings = Field(default_factory=PracticePortalSettings)


def _display_name(c: dict) -> str:
    people = c.get("contacts") or []
    p = people[0] if people else {}
    name = " ".join(x for x in (p.get("first_name"), p.get("last_name")) if x).strip()
    return name or c.get("company_name") or "Unnamed contact"


@router.get("/contacts")
async def list_contacts(status: str = "Active", user: dict = Depends(_guard)):
    q = {"owner_id": user["id"]}
    if status != "All":
        q["status"] = status
    docs = await db.practice_contacts.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [{**d, "display_name": _display_name(d)} for d in docs]


@router.post("/contacts")
async def create_contact(inp: PracticeContactIn, user: dict = Depends(_guard)):
    if not inp.contacts or not (inp.contacts[0].first_name or inp.contacts[0].last_name or inp.company_name):
        raise HTTPException(400, "Enter a first name, last name, or company.")
    now = datetime.now(timezone.utc).isoformat()
    count = await db.practice_contacts.count_documents({"owner_id": user["id"]})
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **inp.model_dump(),
           "internal_id": int(inp.number) if (inp.number or "").isdigit() else count + 1,
           "created_at": now, "updated_at": now}
    await db.practice_contacts.insert_one(doc)
    doc.pop("_id", None)
    return {**doc, "display_name": _display_name(doc)}


@router.get("/contacts/{contact_id}")
async def get_contact(contact_id: str, user: dict = Depends(_guard)):
    doc = await db.practice_contacts.find_one({"id": contact_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Contact not found")
    return {**doc, "display_name": _display_name(doc)}
